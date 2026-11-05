import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import {
  AUTH_METHOD_CONTRACT,
  type AuthMethod,
  type AuthMethodParameters,
  UPSTREAM_STEP_URN,
  type UpstreamCallbackOutcome,
  type UserAttribute,
  type VerifiedIdentity,
} from '@qauth-labs/plugin-sdk';

import { configSchema, endpointsOf, type GitHubConfig } from './config.js';
import { GITHUB_SCOPE, GitHubFailure, readPerson, redeemCode } from './github.js';

/**
 * GitHub sign-in as a QAuth AuthMethod (contract `qauth-auth-method/1-rc.0`).
 *
 * 1. `start()` makes a fresh `state` and PKCE verifier for each sign-in,
 *    keeps both in the transaction the server holds, and sends the browser
 *    to GitHub's authorization page with the state, the verifier's S256
 *    challenge and the `user:email` scope. The state is the binding: the
 *    server refuses a callback that does not carry it back before this code
 *    runs.
 * 2. GitHub sends the browser back to `/upstream/github/callback`, a URL of
 *    this provider alone. GitHub issues no ID token and no `nonce`, so the
 *    state, checked against the flow cookie the start bound, and that URL are
 *    what tie the answer to the sign-in that asked for it.
 * 3. The callback redeems the code (with the verifier), reads the person with
 *    the access token, and drops the token. The person is their numeric
 *    GitHub user id under the GitHub that issued it; the login name, which
 *    can change, is only an attribute.
 */

/** The method's type: its route prefix (`/upstream/github/…`) and the source of its attributes. */
export const GITHUB_TYPE = 'github';

/** The path of the callback, below the method's prefix. */
export const CALLBACK_PATH = '/callback';

/** What `start()` asks the server to keep until the callback. */
export interface GitHubTransaction {
  readonly state: string;
  /** The PKCE verifier (RFC 7636 §4.1): 32 random bytes, base64url. */
  readonly codeVerifier: string;
}

/** What the callback hands `verify()`: never the access token. */
interface GitHubResult {
  readonly issuer: string;
  readonly id: string;
  readonly login: string;
  readonly name: string | undefined;
  readonly email: string | undefined;
  readonly emailVerified: boolean;
}

/** The results the callback produced and `verify()` has not used yet. */
const issued = new WeakSet();

/** The longest authorization code the callback takes. */
const MAX_CODE_LENGTH = 1024;

/** The longest attribute value the server accepts. */
const MAX_ATTRIBUTE_LENGTH = 8192;

/** A control character an attribute value may not hold: C0 but tab and line breaks, and DEL. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** One parameter's single value; a missing or repeated one is `undefined`. */
function single(parameters: AuthMethodParameters, name: string): string | undefined {
  const value = parameters[name];
  return typeof value === 'string' ? value : undefined;
}

/** The S256 code challenge of a PKCE verifier (RFC 7636 §4.2). */
function s256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/** Constant-time string equality. */
function sameText(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The transaction the server handed back, as `start()` made it. */
function transactionOf(value: unknown): GitHubTransaction | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { state, codeVerifier } = value as Record<string, unknown>;
  return typeof state === 'string' && typeof codeVerifier === 'string'
    ? { state, codeVerifier }
    : undefined;
}

/** Whether the server takes `value` as an attribute value. */
function isAttributeValue(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ATTRIBUTE_LENGTH &&
    !CONTROL_CHARACTER.test(value) &&
    (String.prototype as unknown as { isWellFormed(this: string): boolean }).isWellFormed.call(
      value
    )
  );
}

/** The plugin's method: what the package exports as `authMethod`. */
export const authMethod: AuthMethod<GitHubConfig, GitHubTransaction> = {
  contract: AUTH_METHOD_CONTRACT,
  type: GITHUB_TYPE,
  id: 'github',
  display: { name: 'GitHub' },
  configSchema,
  steps: [UPSTREAM_STEP_URN],

  async start(_request, context) {
    const { config } = context;
    // 32 random bytes each: 43 base64url characters.
    const state = randomBytes(32).toString('base64url');
    const codeVerifier = randomBytes(32).toString('base64url');
    const url = new URL(endpointsOf(config).authorize);
    // GitHub ignores `response_type`; it is sent for the OAuth 2.0 request's
    // own shape (RFC 6749 §4.1.1).
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', config.clientId);
    url.searchParams.set('redirect_uri', context.routeUrl(CALLBACK_PATH));
    url.searchParams.set('scope', GITHUB_SCOPE);
    url.searchParams.set('state', state);
    // github.com accepts PKCE with S256 for OAuth apps and GitHub Apps. A
    // server that does not know the parameters ignores them (RFC 6749 §3.1).
    url.searchParams.set('code_challenge', s256(codeVerifier));
    url.searchParams.set('code_challenge_method', 'S256');
    return { redirectTo: url.href, transaction: { state, codeVerifier }, binding: state };
  },

  routes: [
    {
      kind: 'callback',
      method: 'GET',
      path: CALLBACK_PATH,
      // The server has matched `state` with this transaction's binding
      // before this runs; it is compared once more here, for nothing.
      async handle(request, context): Promise<UpstreamCallbackOutcome> {
        const transaction = transactionOf(request.transaction);
        const state = single(request.query, 'state');
        if (
          transaction === undefined ||
          state === undefined ||
          !sameText(state, transaction.state)
        ) {
          return { kind: 'failed', reason: 'transaction_mismatch' };
        }
        const error = single(request.query, 'error');
        if (error === 'access_denied') return { kind: 'declined' };
        if (error !== undefined) return { kind: 'failed', reason: 'provider_error' };
        const code = single(request.query, 'code');
        if (code === undefined || code.length === 0 || code.length > MAX_CODE_LENGTH) {
          return { kind: 'failed', reason: 'invalid_response' };
        }

        let result: GitHubResult;
        try {
          const accessToken = await redeemCode(
            context,
            code,
            transaction.codeVerifier,
            context.routeUrl(CALLBACK_PATH)
          );
          // The token is used for these two reads, then dropped.
          const person = await readPerson(context, accessToken);
          result = Object.freeze({ issuer: endpointsOf(context.config).issuer, ...person });
        } catch (failure) {
          if (failure instanceof GitHubFailure) {
            return { kind: 'failed', reason: failure.reason };
          }
          throw failure;
        }
        issued.add(result);
        return { kind: 'result', result };
      },
    },
  ],

  async verify(input: unknown): Promise<VerifiedIdentity> {
    if (typeof input !== 'object' || input === null || !issued.has(input)) {
      throw new Error('not a result of the GitHub callback');
    }
    // Single use: a result signs one person in once.
    issued.delete(input);
    const result = input as GitHubResult;
    return {
      // The numeric id, never the login: a login can change hands.
      externalSub: result.id,
      assuranceLevel: 'low',
      rawClaims: {
        // The GitHub that assigned the id: an id is unique only within it.
        iss: result.issuer,
        sub: result.id,
        login: result.login,
        ...(result.name === undefined ? {} : { name: result.name }),
        ...(result.email === undefined
          ? {}
          : { email: result.email, email_verified: result.emailVerified }),
      },
    };
  },

  extractAttributes(identity: VerifiedIdentity): UserAttribute[] {
    const claims = identity.rawClaims;
    const claim = (name: string): unknown =>
      Object.hasOwn(claims, name) ? claims[name] : undefined;
    const attributes: UserAttribute[] = [];
    const add = (attrKey: string, value: unknown, verified: boolean): void => {
      if (isAttributeValue(value)) {
        attributes.push({ source: GITHUB_TYPE, attrKey, attrValue: value, verified });
      }
    };
    // Verified only for the primary address GitHub marks verified.
    add('email', claim('email'), claim('email_verified') === true);
    // The login and the display name are the person's own words: never verified.
    add('preferred_username', claim('login'), false);
    add('name', claim('name'), false);
    return attributes;
  },
};
