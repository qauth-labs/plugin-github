import type {
  AuthMethodContext,
  AuthMethodEgressRequest,
  AuthMethodEgressResponse,
  UpstreamFailureReason,
} from '@qauth-labs/plugin-sdk';
import { z } from 'zod';

import { endpointsOf, type GitHubConfig } from './config.js';

/**
 * GitHub's side of a sign-in: redeem the code, then read the person with the
 * access token. GitHub offers no OpenID Connect sign-in (no ID token, no
 * `nonce`), so the person is whoever the REST API says the token belongs to.
 *
 * Every call goes through the egress client the server hands the plugin
 * (`context.egress`), never `fetch`. Each call that carries a credential (the
 * code and the client secret, the access token) follows no redirect, so a
 * `307` cannot send the credential on. The access token is used for the two
 * reads of one sign-in and then dropped: it is never stored, logged or handed
 * to the server.
 */

/** The scope the plugin asks for: the person's email addresses, read-only. Nothing else. */
export const GITHUB_SCOPE = 'user:email';

/** The REST API version the plugin is written against. */
export const GITHUB_API_VERSION = '2022-11-28';

/** GitHub refuses an API call without a `User-Agent`. */
export const USER_AGENT = 'qauth-labs-plugin-github';

/** The most email addresses one page of `/user/emails` holds (GitHub's own maximum). */
const EMAILS_PER_PAGE = 100;

/** An OAuth error code as it may be logged: printable ASCII, short. */
const LOGGABLE_ERROR_CODE = /^[\x20-\x21\x23-\x5b\x5d-\x7e]{1,64}$/;

/** A sign-in that cannot go on, with the reason the server is told. */
export class GitHubFailure extends Error {
  override readonly name = 'GitHubFailure';
  constructor(
    readonly reason: UpstreamFailureReason,
    message: string
  ) {
    super(message);
  }
}

/** The person as GitHub's REST API describes them. */
export interface GitHubPerson {
  /** The numeric user id, as a decimal string: the subject. Never changes. */
  readonly id: string;
  /** The login name. It can change, so it is never the subject. */
  readonly login: string;
  /** The display name, when the person set one. */
  readonly name: string | undefined;
  /** The primary email address, when GitHub lists exactly one. */
  readonly email: string | undefined;
  /** Whether GitHub verified that primary address. */
  readonly emailVerified: boolean;
}

const tokenAnswerSchema = z.object({
  access_token: z.string().min(1).max(4096),
  token_type: z.string().optional(),
});

const userSchema = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  login: z.string().min(1).max(255),
  name: z.string().nullish(),
});

const emailsSchema = z
  .array(
    z.object({
      email: z.string().min(3).max(320),
      primary: z.boolean(),
      verified: z.boolean(),
    })
  )
  .max(EMAILS_PER_PAGE);

/** The JSON of an answer's body, or `undefined` when it is not JSON. */
function jsonBody(answer: AuthMethodEgressResponse): unknown {
  try {
    return JSON.parse(Buffer.from(answer.body).toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/** The `error` member of an OAuth error answer, as it may be logged. */
function loggableError(body: unknown): string {
  const error =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)['error']
      : undefined;
  return typeof error === 'string' && LOGGABLE_ERROR_CODE.test(error) ? error : 'no error code';
}

/** Send one call; a refused or failed call means GitHub cannot be reached. */
async function send(
  context: AuthMethodContext<GitHubConfig>,
  request: AuthMethodEgressRequest
): Promise<AuthMethodEgressResponse> {
  try {
    return await context.egress.request(request);
  } catch {
    // The egress client's error can quote the URL; the purpose says enough.
    context.log.warn(
      { purpose: request.purpose },
      'GitHub could not be reached, or the egress client refused the call'
    );
    throw new GitHubFailure('upstream_unavailable', `${request.purpose}: no answer`);
  }
}

/** Throw for a status that is not `200`: `429` and `5xx` mean GitHub is unavailable. */
function checkStatus(
  context: AuthMethodContext<GitHubConfig>,
  answer: AuthMethodEgressResponse,
  purpose: string
): void {
  if (answer.status === 200) return;
  context.log.warn({ purpose, status: answer.status }, 'GitHub answered a status that is not 200');
  if (answer.status === 429 || answer.status >= 500) {
    throw new GitHubFailure('upstream_unavailable', `${purpose}: ${String(answer.status)}`);
  }
  throw new GitHubFailure('invalid_response', `${purpose}: ${String(answer.status)}`);
}

/**
 * Redeem the code at GitHub's token endpoint, asking for JSON; the access
 * token. The request carries the PKCE verifier, and the same `redirect_uri`
 * the authorization request named.
 */
export async function redeemCode(
  context: AuthMethodContext<GitHubConfig>,
  code: string,
  codeVerifier: string,
  redirectUri: string
): Promise<string> {
  const { config } = context;
  const endpoints = endpointsOf(config);
  const purpose = 'upstream-token';
  const answer = await send(context, {
    method: 'POST',
    url: endpoints.token,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      'user-agent': USER_AGENT,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }).toString(),
    purpose,
    source: endpoints.source,
    // The body carries the code and the secret: a 307 must not send it on.
    redirect: 'error',
  });
  if (answer.status === 429 || answer.status >= 500) {
    checkStatus(context, answer, purpose);
  }
  const body = jsonBody(answer);
  // GitHub answers an OAuth error with 200 and an `error` member.
  if (
    (typeof body === 'object' && body !== null && 'error' in body) ||
    answer.status === 400 ||
    answer.status === 401 ||
    answer.status === 403
  ) {
    const code = loggableError(body);
    context.log.warn({ purpose, status: answer.status, error: code }, 'GitHub refused the code');
    throw new GitHubFailure('provider_error', `${purpose}: ${code}`);
  }
  checkStatus(context, answer, purpose);
  const token = tokenAnswerSchema.safeParse(body);
  if (!token.success) {
    throw new GitHubFailure('invalid_response', `${purpose}: no access token`);
  }
  if (token.data.token_type !== undefined && token.data.token_type.toLowerCase() !== 'bearer') {
    throw new GitHubFailure('invalid_response', `${purpose}: not a bearer token`);
  }
  return token.data.access_token;
}

/** One read of GitHub's REST API with the access token; its JSON. */
async function readApi(
  context: AuthMethodContext<GitHubConfig>,
  accessToken: string,
  path: string,
  purpose: string
): Promise<unknown> {
  const endpoints = endpointsOf(context.config);
  const answer = await send(context, {
    method: 'GET',
    url: `${endpoints.api}${path}`,
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': GITHUB_API_VERSION,
      'user-agent': USER_AGENT,
    },
    purpose,
    source: endpoints.source,
    // The request carries the access token: follow no redirect with it.
    redirect: 'error',
  });
  checkStatus(context, answer, purpose);
  return jsonBody(answer);
}

/**
 * Read the person the access token belongs to: `GET /user` for the id, the
 * login and the display name, and `GET /user/emails` (the `user:email`
 * scope) for the primary address and whether GitHub verified it.
 */
export async function readPerson(
  context: AuthMethodContext<GitHubConfig>,
  accessToken: string
): Promise<GitHubPerson> {
  const [userBody, emailsBody] = await Promise.all([
    readApi(context, accessToken, '/user', 'upstream-user'),
    readApi(
      context,
      accessToken,
      `/user/emails?per_page=${String(EMAILS_PER_PAGE)}`,
      'upstream-user-emails'
    ),
  ]);
  const user = userSchema.safeParse(userBody);
  if (!user.success) {
    throw new GitHubFailure('invalid_response', 'upstream-user: not a GitHub user');
  }
  const emails = emailsSchema.safeParse(emailsBody);
  if (!emails.success) {
    throw new GitHubFailure('invalid_response', 'upstream-user-emails: not a list of addresses');
  }
  // GitHub marks one address primary. Only that one is taken, and it counts
  // as verified only when GitHub says so; a list with none, or with two,
  // gives no address at all.
  const primary = emails.data.filter((entry) => entry.primary);
  const chosen = primary.length === 1 ? primary[0] : undefined;
  return {
    id: String(user.data.id),
    login: user.data.login,
    name: user.data.name ?? undefined,
    email: chosen?.email,
    emailVerified: chosen?.verified === true,
  };
}
