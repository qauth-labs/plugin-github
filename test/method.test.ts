import { createHash } from 'node:crypto';

import type {
  AuthMethodCallbackRoute,
  AuthMethodEgressRequest,
  AuthMethodParameters,
  UpstreamCallbackOutcome,
  UserAttribute,
  VerifiedIdentity,
} from '@qauth-labs/plugin-sdk';
import { assertAuthMethod } from '@qauth-labs/plugin-sdk';
import { beforeEach, describe, expect, it } from 'vitest';

import { configSchema, type GitHubConfig } from '../src/config.js';
import { authMethod, type GitHubTransaction } from '../src/index.js';
import { type FakeContext, fakeContext, REALM_ORIGIN } from './fake-context.js';
import { CONFIG, FakeGitHub } from './fake-github.js';

const callback = authMethod.routes[0] as AuthMethodCallbackRoute<GitHubConfig, GitHubTransaction>;

/** One sign-in, from `start()` to the callback's outcome. */
async function callbackOutcome(
  fake: FakeGitHub,
  context: FakeContext,
  query?: (authorizationRequest: URL, code: string) => AuthMethodParameters
): Promise<UpstreamCallbackOutcome> {
  const start = await authMethod.start({ uiLocales: [] }, context);
  const authorizationRequest = new URL(start.redirectTo);
  const code = fake.authorize(authorizationRequest);
  return callback.handle(
    {
      method: 'GET',
      query: query?.(authorizationRequest, code) ?? {
        code,
        state: authorizationRequest.searchParams.get('state') ?? '',
      },
      form: {},
      transaction: start.transaction,
    },
    context
  );
}

/** One whole sign-in: the identity and the attributes the server gets. */
async function signIn(
  fake: FakeGitHub,
  context: FakeContext
): Promise<{ identity: VerifiedIdentity; attributes: UserAttribute[] }> {
  const outcome = await callbackOutcome(fake, context);
  if (outcome.kind !== 'result') throw new Error(`no result: ${JSON.stringify(outcome)}`);
  const identity = await authMethod.verify(outcome.result);
  return { identity, attributes: authMethod.extractAttributes(identity) };
}

function attribute(attributes: UserAttribute[], key: string): UserAttribute | undefined {
  return attributes.find((entry) => entry.attrKey === key);
}

describe('the GitHub AuthMethod', () => {
  let fake: FakeGitHub;
  let context: FakeContext;

  beforeEach(() => {
    fake = new FakeGitHub();
    context = fakeContext(CONFIG, fake.answer);
  });

  it('meets the static checks of the contract', () => {
    expect(() => {
      assertAuthMethod(authMethod);
    }).not.toThrow();
    expect(authMethod.type).toBe('github');
    expect(authMethod.id).toBe('github');
    expect(authMethod.routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      'GET /callback',
    ]);
  });

  describe('start()', () => {
    it('sends the browser to GitHub with state, PKCE S256, the user:email scope and its own callback', async () => {
      const start = await authMethod.start({ uiLocales: ['tr'] }, context);
      const url = new URL(start.redirectTo);
      expect(`${url.origin}${url.pathname}`).toBe('https://github.com/login/oauth/authorize');
      expect(url.searchParams.get('client_id')).toBe(CONFIG.clientId);
      expect(url.searchParams.get('redirect_uri')).toBe(`${REALM_ORIGIN}/upstream/github/callback`);
      expect(url.searchParams.get('scope')).toBe('user:email');
      expect(url.searchParams.get('state')).toBe(start.transaction.state);
      expect(start.binding).toBe(start.transaction.state);
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('code_challenge')).toBe(
        createHash('sha256').update(start.transaction.codeVerifier, 'ascii').digest('base64url')
      );
      // No call before the browser comes back.
      expect(fake.calls).toEqual([]);
    });

    it('makes a fresh state and verifier for each sign-in', async () => {
      const first = await authMethod.start({ uiLocales: [] }, context);
      const second = await authMethod.start({ uiLocales: [] }, context);
      expect(first.transaction.state).not.toBe(second.transaction.state);
      expect(first.transaction.codeVerifier).not.toBe(second.transaction.codeVerifier);
      expect(first.transaction.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(first.transaction.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it('sends the browser to a GitHub Enterprise Server at its base URL', async () => {
      const config = { ...CONFIG, baseUrl: 'https://github.corp.example/' };
      const start = await authMethod.start({ uiLocales: [] }, fakeContext(config, fake.answer));
      const url = new URL(start.redirectTo);
      expect(`${url.origin}${url.pathname}`).toBe(
        'https://github.corp.example/login/oauth/authorize'
      );
    });
  });

  describe('the callback', () => {
    it('redeems the code with the verifier, reads the person, and keys the identity by the numeric id', async () => {
      const { identity, attributes } = await signIn(fake, context);
      expect(identity.externalSub).toBe('1234567');
      expect(identity.assuranceLevel).toBe('low');
      expect(identity.rawClaims).toEqual({
        iss: 'https://github.com',
        sub: '1234567',
        login: 'octo-person',
        name: 'Octo Person',
        email: 'octo@example.com',
        email_verified: true,
      });
      expect(attributes).toEqual([
        { source: 'github', attrKey: 'email', attrValue: 'octo@example.com', verified: true },
        {
          source: 'github',
          attrKey: 'preferred_username',
          attrValue: 'octo-person',
          verified: false,
        },
        { source: 'github', attrKey: 'name', attrValue: 'Octo Person', verified: false },
      ]);
    });

    it('asks the token endpoint for JSON, sends the secret only there, and follows no redirect with a credential', async () => {
      await signIn(fake, context);
      const [token, ...reads] = fake.calls;
      expect(token).toMatchObject({
        method: 'POST',
        url: 'https://github.com/login/oauth/access_token',
        purpose: 'upstream-token',
        source: 'operator',
        redirect: 'error',
      });
      expect(token?.headers?.['accept']).toBe('application/json');
      const form = new URLSearchParams(token?.body as string);
      expect(form.get('grant_type')).toBe('authorization_code');
      expect(form.get('redirect_uri')).toBe(`${REALM_ORIGIN}/upstream/github/callback`);
      expect(form.get('client_secret')).toBe(CONFIG.clientSecret);
      expect(form.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);

      expect(reads.map((call) => new URL(call.url).pathname).sort()).toEqual([
        '/user',
        '/user/emails',
      ]);
      for (const read of reads) {
        expect(read).toMatchObject({ method: 'GET', redirect: 'error', source: 'operator' });
        expect(read.url.startsWith('https://api.github.com/')).toBe(true);
        expect(read.headers?.['authorization']).toBe(`Bearer ${fake.tokens[0] ?? ''}`);
        expect(read.headers?.['user-agent']).toBe('qauth-labs-plugin-github');
        expect(JSON.stringify(read)).not.toContain(CONFIG.clientSecret);
      }
    });

    it('signs a renamed login in as the same person', async () => {
      const before = await signIn(fake, context);
      fake.person.login = 'renamed-person';
      const after = await signIn(fake, context);
      expect(after.identity.externalSub).toBe(before.identity.externalSub);
      expect(attribute(after.attributes, 'preferred_username')?.attrValue).toBe('renamed-person');
    });

    it('signs a changed email address in as the same person', async () => {
      const before = await signIn(fake, context);
      fake.person.emails = [{ email: 'new@example.org', primary: true, verified: true }];
      const after = await signIn(fake, context);
      expect(after.identity.externalSub).toBe(before.identity.externalSub);
      expect(attribute(after.attributes, 'email')?.attrValue).toBe('new@example.org');
    });

    it('marks the email verified only for the primary address GitHub verified', async () => {
      fake.person.emails = [
        { email: 'primary@example.com', primary: true, verified: false },
        { email: 'other@example.com', primary: false, verified: true },
      ];
      const unverified = await signIn(fake, context);
      expect(attribute(unverified.attributes, 'email')).toEqual({
        source: 'github',
        attrKey: 'email',
        attrValue: 'primary@example.com',
        verified: false,
      });

      fake.person.emails = [{ email: 'other@example.com', primary: false, verified: true }];
      const noPrimary = await signIn(fake, context);
      expect(attribute(noPrimary.attributes, 'email')).toBeUndefined();
      expect(noPrimary.identity.rawClaims).not.toHaveProperty('email');
    });

    it('takes no address when GitHub lists two primary ones', async () => {
      fake.person.emails = [
        { email: 'a@example.com', primary: true, verified: true },
        { email: 'b@example.com', primary: true, verified: true },
      ];
      const { attributes } = await signIn(fake, context);
      expect(attribute(attributes, 'email')).toBeUndefined();
    });

    it('leaves out a display name the person never set', async () => {
      fake.person.name = null;
      const { identity, attributes } = await signIn(fake, context);
      expect(identity.rawClaims).not.toHaveProperty('name');
      expect(attribute(attributes, 'name')).toBeUndefined();
    });

    it('never hands the access token to the server or a log line', async () => {
      const outcome = await callbackOutcome(fake, context);
      expect(outcome.kind).toBe('result');
      const token = fake.tokens[0] ?? 'missing';
      expect(JSON.stringify(outcome)).not.toContain(token);
      const { identity, attributes } = await signIn(fake, context);
      expect(JSON.stringify({ identity, attributes })).not.toContain(fake.tokens[1] ?? 'missing');
      expect(JSON.stringify(context.lines)).not.toContain(token);
    });

    it('ends as declined when the person declines at GitHub', async () => {
      const outcome = await callbackOutcome(fake, context, (request) => ({
        error: 'access_denied',
        state: request.searchParams.get('state') ?? '',
      }));
      expect(outcome).toEqual({ kind: 'declined' });
      expect(fake.calls).toEqual([]);
    });

    it('fails with provider_error for another error GitHub sends back', async () => {
      const outcome = await callbackOutcome(fake, context, (request) => ({
        error: 'redirect_uri_mismatch',
        state: request.searchParams.get('state') ?? '',
      }));
      expect(outcome).toEqual({ kind: 'failed', reason: 'provider_error' });
    });

    it('refuses a callback whose state is not the transaction’s', async () => {
      const outcome = await callbackOutcome(fake, context, (_request, code) => ({
        code,
        state: 'A'.repeat(43),
      }));
      expect(outcome).toEqual({ kind: 'failed', reason: 'transaction_mismatch' });
      expect(fake.calls).toEqual([]);
    });

    it('refuses a callback without a code, or with a repeated one', async () => {
      const missing = await callbackOutcome(fake, context, (request) => ({
        state: request.searchParams.get('state') ?? '',
      }));
      expect(missing).toEqual({ kind: 'failed', reason: 'invalid_response' });
      const repeated = await callbackOutcome(fake, context, (request, code) => ({
        code: [code, code],
        state: request.searchParams.get('state') ?? '',
      }));
      expect(repeated).toEqual({ kind: 'failed', reason: 'invalid_response' });
    });

    it('fails with provider_error when GitHub refuses the code (200 with an error)', async () => {
      const outcome = await callbackOutcome(fake, context, (request) => ({
        code: 'not-a-code-github-issued',
        state: request.searchParams.get('state') ?? '',
      }));
      expect(outcome).toEqual({ kind: 'failed', reason: 'provider_error' });
      expect(context.lines.some((line) => line.fields['error'] === 'bad_verification_code')).toBe(
        true
      );
    });

    it('fails with upstream_unavailable when GitHub cannot be reached or answers 5xx', async () => {
      const refusing = fakeContext(CONFIG, (request: AuthMethodEgressRequest) => {
        if (request.purpose === 'upstream-token') throw new Error('private address refused');
        return fake.answer(request);
      });
      expect(await callbackOutcome(fake, refusing)).toEqual({
        kind: 'failed',
        reason: 'upstream_unavailable',
      });

      fake.overrides.set('/login/oauth/access_token', (request) => ({
        status: 502,
        headers: {},
        body: new Uint8Array(),
        url: request.url,
      }));
      expect(await callbackOutcome(fake, context)).toEqual({
        kind: 'failed',
        reason: 'upstream_unavailable',
      });
    });

    it('fails with invalid_response for an answer that is not GitHub’s', async () => {
      fake.overrides.set('/user', (request) => ({
        status: 200,
        headers: {},
        body: new TextEncoder().encode(JSON.stringify({ id: '1234567', login: 'octo-person' })),
        url: request.url,
      }));
      expect(await callbackOutcome(fake, context)).toEqual({
        kind: 'failed',
        reason: 'invalid_response',
      });
    });

    it('fails with invalid_response when the emails endpoint is refused (no user:email)', async () => {
      fake.overrides.set('/user/emails', (request) => ({
        status: 403,
        headers: {},
        body: new TextEncoder().encode(
          JSON.stringify({ message: 'Resource not accessible by integration' })
        ),
        url: request.url,
      }));
      expect(await callbackOutcome(fake, context)).toEqual({
        kind: 'failed',
        reason: 'invalid_response',
      });
    });
  });

  describe('GitHub Enterprise Server', () => {
    it('redeems at the base URL, reads its API under /api/v3, and names it as the issuer', async () => {
      const config = { ...CONFIG, baseUrl: 'https://github.corp.example:8443' };
      const enterprise = new FakeGitHub(config);
      const { identity } = await signIn(enterprise, fakeContext(config, enterprise.answer));
      expect(identity.rawClaims['iss']).toBe('https://github.corp.example:8443');
      expect(
        enterprise.calls.map((call) => `${call.method} ${call.url} ${call.source}`).sort()
      ).toEqual([
        'GET https://github.corp.example:8443/api/v3/user admin',
        'GET https://github.corp.example:8443/api/v3/user/emails?per_page=100 admin',
        'POST https://github.corp.example:8443/login/oauth/access_token admin',
      ]);
    });

    it('treats a base URL of github.com as github.com', async () => {
      const config = { ...CONFIG, baseUrl: 'https://github.com' };
      const github = new FakeGitHub(config);
      const { identity } = await signIn(github, fakeContext(config, github.answer));
      expect(identity.rawClaims['iss']).toBe('https://github.com');
      expect(github.calls.some((call) => call.url.startsWith('https://api.github.com/user'))).toBe(
        true
      );
    });
  });

  describe('verify()', () => {
    it('takes only a result of its own callback, once', async () => {
      const outcome = await callbackOutcome(fake, context);
      if (outcome.kind !== 'result') throw new Error('no result');
      await expect(authMethod.verify({ ...(outcome.result as object) })).rejects.toThrow();
      await expect(
        authMethod.verify({ externalSub: '1', assuranceLevel: 'high', rawClaims: {} })
      ).rejects.toThrow();
      await expect(authMethod.verify(outcome.result)).resolves.toMatchObject({
        externalSub: '1234567',
      });
      await expect(authMethod.verify(outcome.result)).rejects.toThrow();
    });
  });

  describe('the config', () => {
    it('takes a client id and secret, and an https base URL with nothing past the host and port', () => {
      expect(configSchema.safeParse(CONFIG).success).toBe(true);
      for (const baseUrl of [
        'https://github.corp.example',
        'https://github.corp.example/',
        'https://10.1.2.3:8443',
      ]) {
        expect(configSchema.safeParse({ ...CONFIG, baseUrl }).success, baseUrl).toBe(true);
      }
      for (const baseUrl of [
        'http://github.corp.example',
        'https://github.corp.example/api/v3',
        'https://user:pass@github.corp.example',
        'https://github.corp.example?x=1',
        'https://github.corp.example#top',
        'github.corp.example',
      ]) {
        expect(configSchema.safeParse({ ...CONFIG, baseUrl }).success, baseUrl).toBe(false);
      }
      expect(configSchema.safeParse({ ...CONFIG, clientSecret: '' }).success).toBe(false);
      expect(configSchema.safeParse({ ...CONFIG, clientId: 'has space' }).success).toBe(false);
    });

    it('marks the client secret write-only', () => {
      const schema = configSchema.toJSONSchema() as {
        properties: Record<string, { writeOnly?: boolean }>;
      };
      expect(schema.properties['clientSecret']?.writeOnly).toBe(true);
      expect(schema.properties['clientId']?.writeOnly).toBeUndefined();
      expect(schema.properties['baseUrl']?.writeOnly).toBeUndefined();
    });
  });
});
