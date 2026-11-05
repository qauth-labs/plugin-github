/**
 * The plugin end to end, where an operator runs it: QAuth's released server
 * image with the plugin installed on top (e2e/Dockerfile), against a mock
 * GitHub Enterprise Server on the deployment's private network. The suite
 * configures the plugin through the admin API, as an operator does, and signs
 * in through the server's own pages, as a browser does.
 *
 * Run it through e2e/run.sh.
 */
import { createHash, randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  Admin,
  browse,
  CookieJar,
  databaseDump,
  formsOf,
  issuedTokens,
  linkWithClass,
  literal,
  logsOf,
  MOCK,
  mockCalls,
  mockClient,
  type MockPerson,
  setPerson,
  sql,
} from './harness.js';

/** Where the test application wants the code; nothing listens there. */
const REDIRECT_URI = 'http://127.0.0.1:9/plugin-github-e2e/callback';
/** The callback this provider alone uses. */
const CALLBACK = 'http://localhost:3000/upstream/github/callback';
/** The mock GitHub under the name the operator's allowlist names. */
const LISTED_BASE_URL = 'https://mock-github:8443';
/** The same mock under a name the allowlist does not name. */
const UNLISTED_BASE_URL = 'https://mock-github-unlisted:8443';

const SIGN_IN_FAILED = 'urn:qauth:event:user.sign_in_failed:v1-rc.0';
const REGISTERED = 'urn:qauth:event:user.registered:v1-rc.0';

let admin: Admin;
let clientId: string;
let realmId: string;

function isRedirect(response: Response): boolean {
  return response.status === 302 || response.status === 303;
}

/** Configure the plugin for the realm and enable it, through the admin API. */
async function configure(baseUrl: string): Promise<void> {
  const { clientId: githubClientId, clientSecret } = mockClient();
  const current = await admin.call('GET', '/plugins/github');
  expect(current.status).toBe(200);
  const sealed = await admin.call('POST', '/plugins/github/secrets/seal', {
    path: 'clientSecret',
    value: clientSecret,
  });
  expect(sealed.status).toBe(200);
  const body = {
    version: current.body['version'],
    config: { clientId: githubClientId, baseUrl },
    secrets: { clientSecret: { sealed: sealed.body['sealed'] } },
  };
  const configured = await admin.call('POST', '/plugins/github/config', body, {
    'qauth-approval': await admin.approved('plugins.update', body),
  });
  expect(configured.status, JSON.stringify(configured.body)).toBe(200);
  if (configured.body['enabled'] !== true) {
    const enableBody = { version: configured.body['version'] };
    const enabled = await admin.call('POST', '/plugins/github/enable', enableBody, {
      'qauth-approval': await admin.approved('plugins.enable', enableBody),
    });
    expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
    expect(enabled.body['enabled']).toBe(true);
  }
}

/** A sign-in started at the server and sent on to GitHub. */
interface StartedSignIn {
  readonly jar: CookieJar;
  /** GitHub's authorization page, as the server sent the browser there. */
  readonly providerUrl: URL;
}

/** An application asks the server to sign someone in through GitHub. */
async function startSignIn(): Promise<StartedSignIn> {
  const jar = new CookieJar();
  const verifier = randomBytes(32).toString('base64url');
  const authorize = new URL('/oauth/authorize', 'http://localhost:3000');
  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: 'openid',
    state: randomBytes(16).toString('base64url'),
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    qauth_upstream: 'github',
  }).toString();
  const toStart = await browse(jar, authorize);
  expect(isRedirect(toStart)).toBe(true);
  const startUrl = toStart.headers.get('location') ?? '';
  expect(startUrl).toMatch(/^\/ui\/upstream\/github\/start\?/);
  const start = await browse(jar, startUrl);
  expect(start.status).toBe(200);
  const href = linkWithClass(await start.text(), 'alt-action');
  expect(href).toBeDefined();
  return { jar, providerUrl: new URL(href ?? '') };
}

/**
 * The person signs in at the mock's authorization page; the URL GitHub sends
 * the browser back to. The suite reaches the mock from the host as localhost.
 */
async function atGitHub(providerUrl: URL): Promise<URL> {
  const page = new URL(providerUrl.pathname + providerUrl.search, MOCK);
  const answer = await fetch(page, { redirect: 'manual' });
  expect(isRedirect(answer)).toBe(true);
  const back = new URL(answer.headers.get('location') ?? '');
  expect(`${back.origin}${back.pathname}`).toBe(CALLBACK);
  return back;
}

/**
 * Follow the server from the callback to the application, granting consent
 * on the way when the page asks; the code the application receives.
 */
async function toApplication(jar: CookieJar, afterCallback: Response): Promise<string> {
  let response = afterCallback;
  for (let step = 0; step < 10; step += 1) {
    const location = response.headers.get('location');
    if (isRedirect(response) && location !== null) {
      const next = new URL(location, 'http://localhost:3000');
      if (next.href.startsWith(REDIRECT_URI)) {
        const code = next.searchParams.get('code');
        expect(next.searchParams.get('error')).toBeNull();
        expect(code).not.toBeNull();
        return code ?? '';
      }
      response = await browse(jar, next);
      continue;
    }
    expect(response.status, `step ${String(step)}`).toBe(200);
    const consent = formsOf(await response.text()).find(
      (form) =>
        form.action.endsWith('/ui/consent') ||
        form.buttons.some((button) => button.name === 'decision' && button.value === 'allow')
    );
    expect(consent, 'a consent form').toBeDefined();
    if (consent === undefined) break;
    const form = new URLSearchParams(consent.fields);
    form.set('decision', 'allow');
    response = await browse(jar, consent.action, { method: 'POST', form });
  }
  throw new Error('the server did not send the browser back to the application');
}

/** A whole sign-in of `person`; the code the application receives. */
async function signIn(person: MockPerson): Promise<string> {
  await setPerson(person);
  const { jar, providerUrl } = await startSignIn();
  const back = await atGitHub(providerUrl);
  const callback = await browse(jar, back);
  expect(isRedirect(callback), await callback.clone().text()).toBe(true);
  return toApplication(jar, callback);
}

/** The accounts the GitHub credential of `id` belongs to. */
function accountsOf(id: number): string[] {
  return sql(
    `SELECT user_id FROM user_credentials
     WHERE provider_type = 'github' AND external_sub = ${literal(String(id))}`
  );
}

function userCount(): number {
  return Number(sql('SELECT count(*) FROM users')[0]);
}

/** The attributes the plugin wrote for an account: key, value and whether verified. */
function attributesOf(accountId: string): { key: string; value: string; verified: boolean }[] {
  return sql(
    `SELECT attr_key, attr_value, verified FROM user_attributes
     WHERE user_id = ${literal(accountId)} AND source = 'github' ORDER BY attr_key`
  ).map((row) => {
    const [key = '', value = '', verified = ''] = row.split('|');
    return { key, value, verified: verified === 't' };
  });
}

function failedSignIns(reason: string): number {
  return Number(
    sql(
      `SELECT count(*) FROM events WHERE type = ${literal(SIGN_IN_FAILED)}
       AND data->>'method' = 'upstream' AND data->>'reason' = ${literal(reason)}`
    )[0]
  );
}

const octo: MockPerson = {
  id: 58_000_001,
  login: 'octo-first',
  name: 'Octo First',
  emails: [
    { email: 'octo@example.com', primary: true, verified: true },
    { email: '58000001+octo-first@users.noreply.example.com', primary: false, verified: true },
  ],
};

beforeAll(async () => {
  const [master] = sql(`SELECT id FROM realms WHERE name = 'master'`);
  if (master === undefined) throw new Error('no master realm');
  realmId = master;
  admin = await Admin.create(realmId);
  const registered = await fetch('http://localhost:3000/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'plugin-github e2e application',
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'openid',
    }),
  });
  expect(registered.status).toBe(201);
  clientId = ((await registered.json()) as { client_id: string }).client_id;
});

describe('the boot', () => {
  it('loads the plugin as an operator-installed package while PLUGIN_API_ENABLED is on', () => {
    expect(logsOf('auth-server')).toContain(
      'AuthMethod plugin @qauth-labs/plugin-github loaded: github (github)'
    );
  });

  it('skips the plugin with PLUGIN_API_ENABLED off, and says why', () => {
    const log = logsOf('auth-server-plugin-api-off');
    expect(log).toContain(
      'The AuthMethod plugin @qauth-labs/plugin-github is not loaded: it is not a first-party plugin, and the experimental plugin API is off.'
    );
    expect(log).not.toContain('AuthMethod plugin @qauth-labs/plugin-github loaded');
  });

  it('lists the plugin in the admin API, not configured yet', async () => {
    const plugin = await admin.call('GET', '/plugins/github');
    expect(plugin.status).toBe(200);
    expect(plugin.body).toMatchObject({
      type: 'github',
      package: '@qauth-labs/plugin-github',
      firstParty: false,
      contract: 'qauth-auth-method/1-rc.0',
      enabled: false,
    });
  });
});

describe('a private base URL', () => {
  it('is refused while the operator allowlist does not name it', async () => {
    await configure(UNLISTED_BASE_URL);
    await setPerson(octo);
    const refusedBefore = failedSignIns('upstream_unavailable');
    const callsBefore = (await mockCalls()).length;

    const { jar, providerUrl } = await startSignIn();
    expect(providerUrl.origin).toBe(UNLISTED_BASE_URL);
    const back = await atGitHub(providerUrl);
    const callback = await browse(jar, back);

    expect(callback.status).toBe(400);
    expect(await callback.text()).toContain('We could not sign you in');
    expect(failedSignIns('upstream_unavailable')).toBe(refusedBefore + 1);
    // The egress client refused the address before anything was sent: the
    // mock saw the browser at its authorization page, and nothing else.
    const calls = (await mockCalls()).slice(callsBefore);
    expect(calls.map((call) => call.path)).toEqual(['/login/oauth/authorize']);
    expect(logsOf('auth-server')).toContain('egress call blocked');
    expect(accountsOf(octo.id)).toEqual([]);
  });

  it('works once it is the name the allowlist names', async () => {
    await configure(LISTED_BASE_URL);
    const { providerUrl } = await startSignIn();
    expect(providerUrl.origin).toBe(LISTED_BASE_URL);
  });
});

describe('sign-in', () => {
  let account: string;

  it('the first sign-in creates an account keyed by the numeric id', async () => {
    const before = userCount();
    await signIn(octo);

    const accounts = accountsOf(octo.id);
    expect(accounts).toHaveLength(1);
    account = accounts[0] ?? '';
    expect(userCount()).toBe(before + 1);
    // The subject is the id, under the GitHub that issued it; never the login.
    const [credential] = sql(
      `SELECT external_sub, credential_data->>'iss' FROM user_credentials
       WHERE user_id = ${literal(account)} AND provider_type = 'github'`
    );
    expect(credential).toBe(`${String(octo.id)}|${LISTED_BASE_URL}`);
    expect(
      sql(`SELECT 1 FROM user_credentials WHERE external_sub = ${literal(octo.login)}`)
    ).toEqual([]);
    expect(
      sql(
        `SELECT data->>'method' FROM events
         WHERE type = ${literal(REGISTERED)} AND subject_id = ${literal(account)}`
      )
    ).toEqual(['upstream']);
  });

  it('stores the primary verified email as verified, the login and the name as unverified', () => {
    expect(attributesOf(account)).toEqual([
      { key: 'email', value: 'octo@example.com', verified: true },
      { key: 'name', value: 'Octo First', verified: false },
      { key: 'preferred_username', value: 'octo-first', verified: false },
    ]);
  });

  it('a renamed login signs in the same account', async () => {
    const before = userCount();
    await signIn({ ...octo, login: 'octo-renamed', name: 'Octo Renamed' });
    expect(accountsOf(octo.id)).toEqual([account]);
    expect(userCount()).toBe(before);
  });

  it('a changed email address signs in the same account, and no new account is created', async () => {
    const before = userCount();
    await signIn({
      ...octo,
      emails: [{ email: 'octo-changed@example.com', primary: true, verified: true }],
    });
    expect(accountsOf(octo.id)).toEqual([account]);
    expect(userCount()).toBe(before);
  });

  it('only a primary and verified email becomes a verified attribute', async () => {
    const unverified: MockPerson = {
      id: 58_000_002,
      login: 'octo-unverified',
      name: null,
      emails: [
        { email: 'primary-unverified@example.com', primary: true, verified: false },
        { email: 'other-verified@example.com', primary: false, verified: true },
      ],
    };
    await signIn(unverified);
    const [second] = accountsOf(unverified.id);
    expect(second).toBeDefined();
    expect(second).not.toBe(account);
    // The primary address, unverified; the verified address that is not
    // primary is not taken at all.
    expect(attributesOf(second ?? '')).toEqual([
      { key: 'email', value: 'primary-unverified@example.com', verified: false },
      { key: 'preferred_username', value: 'octo-unverified', verified: false },
    ]);
    expect(
      sql(`SELECT 1 FROM user_attributes WHERE attr_value = 'other-verified@example.com'`)
    ).toEqual([]);
    // No address of the first account is verified but the one it began with.
    expect(
      sql(
        `SELECT attr_value FROM user_attributes
         WHERE source = 'github' AND attr_key = 'email' AND verified`
      )
    ).toEqual(['octo@example.com']);
  });

  it('a callback with a wrong state is refused', async () => {
    await setPerson(octo);
    const mismatchesBefore = failedSignIns('transaction_mismatch');
    const tokensBefore = (await issuedTokens()).length;
    const { jar, providerUrl } = await startSignIn();
    const back = await atGitHub(providerUrl);
    expect(back.searchParams.get('state')).toBe(providerUrl.searchParams.get('state'));

    const forged = new URL(back);
    forged.searchParams.set('state', randomBytes(32).toString('base64url'));
    const refused = await browse(jar, forged);

    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain('We could not sign you in');
    expect(failedSignIns('transaction_mismatch')).toBe(mismatchesBefore + 1);
    // The code was never redeemed.
    expect(await issuedTokens()).toHaveLength(tokensBefore);
  });
});

describe('the access token', () => {
  it('is not in the database, the logs or the events', async () => {
    const tokens = await issuedTokens();
    // One per completed sign-in above.
    expect(tokens.length).toBeGreaterThanOrEqual(4);

    const dump = databaseDump();
    const events = sql('SELECT row_to_json(events)::text FROM events').join('\n');
    const logs = [logsOf('auth-server'), logsOf('auth-server-plugin-api-off')].join('\n');
    expect(events).toContain(REGISTERED);
    for (const token of tokens) {
      expect(dump.includes(token), 'a token in the database').toBe(false);
      expect(events.includes(token), 'a token in the events').toBe(false);
      expect(logs.includes(token), 'a token in the logs').toBe(false);
    }
    // Nor is the client secret, which the server keeps sealed.
    const { clientSecret } = mockClient();
    expect(dump.includes(clientSecret), 'the client secret in the database').toBe(false);
    expect(logs.includes(clientSecret), 'the client secret in the logs').toBe(false);
  });
});
