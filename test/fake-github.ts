/**
 * A fake GitHub for the unit tests and the contract test kit: the
 * authorization page, the token endpoint, `GET /user` and
 * `GET /user/emails`, answering the plugin's egress calls as GitHub does
 * (an OAuth error at the token endpoint is a `200` with an `error` member).
 * It checks what GitHub checks: the client, the code, the `redirect_uri`,
 * the PKCE verifier, the bearer token and the `User-Agent`.
 */
import { createHash, randomBytes } from 'node:crypto';

import type { AuthMethodEgressRequest, AuthMethodEgressResponse } from '@qauth-labs/plugin-sdk';
import type { AuthMethodKitRequest, AuthMethodKitScenario } from '@qauth-labs/plugin-sdk/testing';

import { endpointsOf, type GitHubConfig } from '../src/config.js';

/** One email address as `GET /user/emails` lists it. */
export interface FakeEmail {
  email: string;
  primary: boolean;
  verified: boolean;
  visibility?: 'public' | 'private' | null;
}

/** The person signed in at the fake. Tests change it between sign-ins. */
export interface FakePerson {
  id: number;
  login: string;
  name: string | null;
  emails: FakeEmail[];
}

/** The config the tests give the plugin, with a secret of realistic length. */
export const CONFIG: GitHubConfig = {
  clientId: 'Ov23liFakeClientId01',
  clientSecret: 'fake-github-client-secret-0123456789abcdef',
};

/** What the fake knows about a code it issued. */
interface IssuedCode {
  readonly redirectUri: string;
  readonly challenge: string | undefined;
  readonly challengeMethod: string | undefined;
}

function answer(
  request: AuthMethodEgressRequest,
  status: number,
  body: unknown
): AuthMethodEgressResponse {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: new TextEncoder().encode(JSON.stringify(body)),
    url: request.url,
  };
}

function s256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

export class FakeGitHub {
  readonly person: FakePerson;
  /** Every call the plugin made, in order. */
  readonly calls: AuthMethodEgressRequest[] = [];
  /** Every access token the fake issued. */
  readonly tokens: string[] = [];
  /** Answers that replace the fake's own, by path, for one test. */
  readonly overrides = new Map<
    string,
    (request: AuthMethodEgressRequest) => AuthMethodEgressResponse
  >();
  private readonly codes = new Map<string, IssuedCode>();
  private readonly people = new Map<string, FakePerson>();

  constructor(
    readonly config: GitHubConfig = CONFIG,
    person?: Partial<FakePerson>
  ) {
    this.person = {
      id: 1_234_567,
      login: 'octo-person',
      name: 'Octo Person',
      emails: [
        { email: 'octo@example.com', primary: true, verified: true, visibility: 'private' },
        { email: '1234567+octo-person@users.noreply.github.com', primary: false, verified: true },
      ],
      ...person,
    };
  }

  /** The person signs in on GitHub's authorization page; the code it redirects with. */
  authorize(authorizationRequest: URL): string {
    const endpoints = endpointsOf(this.config);
    if (`${authorizationRequest.origin}${authorizationRequest.pathname}` !== endpoints.authorize) {
      throw new Error(`not the authorization page: ${authorizationRequest.href}`);
    }
    const query = authorizationRequest.searchParams;
    if (query.get('client_id') !== this.config.clientId) throw new Error('another client');
    const redirectUri = query.get('redirect_uri');
    if (redirectUri === null) throw new Error('no redirect_uri');
    const code = randomBytes(10).toString('hex');
    this.codes.set(code, {
      redirectUri,
      challenge: query.get('code_challenge') ?? undefined,
      challengeMethod: query.get('code_challenge_method') ?? undefined,
    });
    return code;
  }

  /** Answer one of the plugin's calls. */
  answer = (request: AuthMethodEgressRequest): AuthMethodEgressResponse => {
    this.calls.push(request);
    const endpoints = endpointsOf(this.config);
    const url = new URL(request.url);
    const override = this.overrides.get(url.pathname);
    if (override !== undefined) return override(request);
    if (request.headers?.['user-agent'] === undefined) {
      return answer(request, 403, { message: 'Request forbidden by administrative rules.' });
    }
    if (request.method === 'POST' && request.url === endpoints.token) return this.token(request);
    if (request.method === 'GET' && url.origin + url.pathname === `${endpoints.api}/user`) {
      const person = this.bearer(request);
      if (person === undefined) return answer(request, 401, { message: 'Bad credentials' });
      return answer(request, 200, {
        login: person.login,
        id: person.id,
        node_id: 'U_fake',
        type: 'User',
        name: person.name,
        email: null,
      });
    }
    if (request.method === 'GET' && url.origin + url.pathname === `${endpoints.api}/user/emails`) {
      const person = this.bearer(request);
      if (person === undefined) return answer(request, 401, { message: 'Bad credentials' });
      return answer(request, 200, person.emails);
    }
    return answer(request, 404, { message: 'Not Found' });
  };

  private token(request: AuthMethodEgressRequest): AuthMethodEgressResponse {
    const form = new URLSearchParams(typeof request.body === 'string' ? request.body : '');
    if (
      form.get('client_id') !== this.config.clientId ||
      form.get('client_secret') !== this.config.clientSecret
    ) {
      return answer(request, 200, { error: 'incorrect_client_credentials' });
    }
    const code = form.get('code') ?? '';
    const issued = this.codes.get(code);
    // A code is good once.
    this.codes.delete(code);
    if (issued === undefined || form.get('redirect_uri') !== issued.redirectUri) {
      return answer(request, 200, { error: 'bad_verification_code' });
    }
    if (issued.challenge !== undefined) {
      const verifier = form.get('code_verifier') ?? '';
      if (issued.challengeMethod !== 'S256' || s256(verifier) !== issued.challenge) {
        return answer(request, 200, { error: 'bad_verification_code' });
      }
    }
    const token = `gho_${randomBytes(18).toString('base64url')}`;
    this.tokens.push(token);
    // The person as they are now, so a rename between sign-ins shows.
    this.people.set(token, this.person);
    return answer(request, 200, { access_token: token, token_type: 'bearer', scope: 'user:email' });
  }

  private bearer(request: AuthMethodEgressRequest): FakePerson | undefined {
    const header = request.headers?.['authorization'] ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    return this.people.get(token);
  }

  /** The browser back at the callback, signed in. */
  callback(authorizationRequest: URL): AuthMethodKitRequest {
    const code = this.authorize(authorizationRequest);
    const state = authorizationRequest.searchParams.get('state') ?? '';
    return { path: '/callback', method: 'GET', query: { code, state } };
  }

  /** The browser back at the callback, the person having declined. */
  declined(authorizationRequest: URL): AuthMethodKitRequest {
    const state = authorizationRequest.searchParams.get('state') ?? '';
    return {
      path: '/callback',
      method: 'GET',
      query: {
        error: 'access_denied',
        error_description: 'The user has denied your application access.',
        state,
      },
    };
  }

  /** The contract test kit's scenario, played by this fake. */
  scenario(): AuthMethodKitScenario {
    return {
      config: this.config,
      egress: this.answer,
      callback: (request) => this.callback(request),
      declined: (request) => this.declined(request),
    };
  }
}
