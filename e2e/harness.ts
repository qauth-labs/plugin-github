/**
 * What the end-to-end suite drives the deployment with: a browser of sorts (a
 * cookie jar and the HTML forms of QAuth's pages), the admin API (an admin
 * account, a DPoP-bound access token and a fresh DPoP proof for each call),
 * the database and the logs (through docker compose), and the mock GitHub's
 * control API. e2e/run.sh starts the deployment and sets the environment.
 */
import { execFileSync } from 'node:child_process';
import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  type JsonWebKey,
  type KeyObject,
  randomBytes,
  randomUUID,
  sign,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The server's public listener, as the suite reaches it. */
export const SERVER = 'http://localhost:3000';
/** The admin API's listener. */
export const ADMIN = 'http://localhost:3002';
/** What DPoP proofs for the admin API name: the server's ADMIN_API_BASE_URL. */
const ADMIN_BASE_URL = 'https://admin.qauth.test';
/** The mock GitHub, from the host. */
export const MOCK = 'https://localhost:8443';
/** The admin API's version prefix. */
const ADMIN_PREFIX = '/admin/v1-rc.0';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set: run the suite through e2e/run.sh`);
  }
  return value;
}

/** Run `docker compose` on the suite's deployment; its standard output. */
export function compose(...args: string[]): string {
  return execFileSync('docker', ['compose', '--file', required('E2E_COMPOSE_FILE'), ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Run one SQL statement in the server's database; its rows, one line each, columns split by `|`. */
export function sql(statement: string): string[] {
  const out = compose(
    'exec',
    '-T',
    'postgres',
    'psql',
    '--username=qauth',
    '--dbname=qauth',
    '--no-align',
    '--tuples-only',
    '--quiet',
    '--set=ON_ERROR_STOP=1',
    '--command',
    statement
  );
  return out.split('\n').filter((line) => line !== '');
}

/** A SQL string literal. */
export function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Everything the server's database holds, as `pg_dump` writes it. */
export function databaseDump(): string {
  return compose(
    'exec',
    '-T',
    'postgres',
    'pg_dump',
    '--username=qauth',
    '--dbname=qauth',
    '--data-only'
  );
}

/** A service's log, as docker keeps it. */
export function logsOf(service: string): string {
  return compose('logs', '--no-color', '--no-log-prefix', service);
}

/** The client secret the mock GitHub expects, and the client id. */
export function mockClient(): { clientId: string; clientSecret: string } {
  return {
    clientId: required('MOCK_GITHUB_CLIENT_ID'),
    clientSecret: required('MOCK_GITHUB_CLIENT_SECRET'),
  };
}

// ---------------------------------------------------------------------------
// The mock GitHub's control API.

export interface MockEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

export interface MockPerson {
  id: number;
  login: string;
  name: string | null;
  emails: MockEmail[];
}

export interface MockCall {
  method: string;
  host: string;
  path: string;
}

async function mockControl(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${MOCK}/_control${path}`, init);
  if (!response.ok) throw new Error(`mock control ${path}: ${String(response.status)}`);
  return response.json();
}

/** Set the person who signs in at the mock's authorization page next. */
export async function setPerson(person: MockPerson): Promise<void> {
  await mockControl('/person', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(person),
  });
}

/** Every access token the mock issued. */
export async function issuedTokens(): Promise<string[]> {
  return ((await mockControl('/tokens')) as { tokens: string[] }).tokens;
}

/** Every call the mock answered. */
export async function mockCalls(): Promise<MockCall[]> {
  return ((await mockControl('/calls')) as { calls: MockCall[] }).calls;
}

// ---------------------------------------------------------------------------
// A browser of sorts.

/** The cookies the server set, by name. Every request goes to one origin. */
export class CookieJar {
  private readonly cookies = new Map<string, string>();

  storeFrom(response: Response): void {
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(';', 1)[0] ?? '';
      const equals = pair.indexOf('=');
      if (equals <= 0) continue;
      const name = pair.slice(0, equals).trim();
      const value = pair.slice(equals + 1).trim();
      if (/;\s*max-age=0\b/i.test(header) || value === '') {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
  }

  header(): string | undefined {
    if (this.cookies.size === 0) return undefined;
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

/** One request to the server with the jar's cookies; redirects are not followed. */
export async function browse(
  jar: CookieJar,
  url: string | URL,
  init: { method?: string; form?: URLSearchParams } = {}
): Promise<Response> {
  const headers: Record<string, string> = {};
  const cookie = jar.header();
  if (cookie !== undefined) headers['cookie'] = cookie;
  let body: string | undefined;
  if (init.form !== undefined) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = init.form.toString();
  }
  const response = await fetch(new URL(url, SERVER), {
    method: init.method ?? 'GET',
    headers,
    redirect: 'manual',
    ...(body === undefined ? {} : { body }),
  });
  jar.storeFrom(response);
  return response;
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** Decode the character references in an HTML attribute value. */
export function decodeAttribute(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, reference: string) => {
    if (reference.startsWith('#')) {
      const code = /^#x/i.test(reference)
        ? Number.parseInt(reference.slice(2), 16)
        : Number.parseInt(reference.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[reference.toLowerCase()] ?? match;
  });
}

function attributesOf(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const body = tag.replace(/^<\s*[a-z]+/i, '').replace(/\/?>$/, '');
  for (const match of body.matchAll(
    /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
  )) {
    const name = match[1];
    if (name === undefined) continue;
    attributes.set(name.toLowerCase(), decodeAttribute(match[2] ?? match[3] ?? match[4] ?? ''));
  }
  return attributes;
}

/** The URL of the first `<a>` with the given class. */
export function linkWithClass(html: string, className: string): string | undefined {
  for (const match of html.matchAll(/<a\b[^>]*>/gi)) {
    const attributes = attributesOf(match[0]);
    const classes = (attributes.get('class') ?? '').split(/\s+/);
    if (classes.includes(className)) return attributes.get('href');
  }
  return undefined;
}

/** A form as the page rendered it. */
export interface HtmlForm {
  readonly action: string;
  readonly fields: URLSearchParams;
  readonly buttons: ReadonlyArray<{ readonly name: string; readonly value: string }>;
}

/** Every `<form>` of a page, with its inputs as a browser would send them. */
export function formsOf(html: string): HtmlForm[] {
  const forms: HtmlForm[] = [];
  for (const match of html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/gi)) {
    const formTag = /^<form\b[^>]*>/i.exec(match[0])?.[0] ?? '<form>';
    const fields = new URLSearchParams();
    for (const input of (match[1] ?? '').matchAll(/<input\b[^>]*>/gi)) {
      const attributes = attributesOf(input[0]);
      const name = attributes.get('name');
      if (name === undefined || name === '') continue;
      const type = (attributes.get('type') ?? 'text').toLowerCase();
      if ((type === 'checkbox' || type === 'radio') && !attributes.has('checked')) continue;
      if (type === 'submit' || type === 'button') continue;
      fields.append(name, attributes.get('value') ?? (type === 'checkbox' ? 'on' : ''));
    }
    const buttons: { name: string; value: string }[] = [];
    for (const button of (match[1] ?? '').matchAll(/<button\b[^>]*>/gi)) {
      const attributes = attributesOf(button[0]);
      const name = attributes.get('name');
      if (name !== undefined && (attributes.get('type') ?? 'submit').toLowerCase() === 'submit') {
        buttons.push({ name, value: attributes.get('value') ?? '' });
      }
    }
    forms.push({ action: attributesOf(formTag).get('action') ?? '', fields, buttons });
  }
  return forms;
}

// ---------------------------------------------------------------------------
// JOSE, with node:crypto alone.

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function jws(
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
  signWith: (input: Buffer) => Buffer
): string {
  const input = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  return `${input}.${base64url(signWith(Buffer.from(input, 'ascii')))}`;
}

/** An RFC 7638 thumbprint of a P-256 public key. */
function thumbprint(jwk: JsonWebKey): string {
  const members = { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y };
  return base64url(createHash('sha256').update(JSON.stringify(members)).digest());
}

/** The admin API, as one security admin of the master realm. */
export class Admin {
  private constructor(
    readonly realmId: string,
    readonly accountId: string,
    private readonly token: string,
    private readonly proofKey: KeyObject,
    private readonly proofJwk: JsonWebKey
  ) {}

  /**
   * Make a security admin for the realm (an account and a grant, written
   * straight into the database, as the operator's bootstrap does), and an
   * access token for it, bound to a fresh DPoP key and signed with the
   * server's key, as the server issues one.
   */
  static async create(realmId: string): Promise<Admin> {
    const [accountId] = sql(
      `WITH account AS (INSERT INTO users (realm_id) VALUES (${literal(realmId)}) RETURNING id)
       INSERT INTO admin_grants (user_id, built_in_role, target_realm_id)
       SELECT id, 'security-admin', ${literal(realmId)} FROM account RETURNING user_id`
    );
    if (accountId === undefined) throw new Error('no admin account');

    const discovery = (await (
      await fetch(`${SERVER}/.well-known/openid-configuration`)
    ).json()) as { issuer: string; jwks_uri: string };
    const signingKey = createPrivateKey(
      readFileSync(join(required('E2E_WORK'), 'keys', 'jwt-private.pem'))
    );
    const signingJwk = signingKey.export({ format: 'jwk' });
    const jwks = (await (
      await fetch(discovery.jwks_uri.replace(/^https?:\/\/[^/]+/, SERVER))
    ).json()) as {
      keys: (JsonWebKey & { kid?: string })[];
    };
    const kid = jwks.keys.find((key) => key.x === signingJwk.x)?.kid;
    if (kid === undefined) throw new Error('the server does not publish its signing key');

    const { privateKey: proofKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const proofJwk = publicKey.export({ format: 'jwk' });
    const now = Math.floor(Date.now() / 1000);
    const token = jws(
      { alg: 'EdDSA', typ: 'at+jwt', kid },
      {
        iss: discovery.issuer,
        sub: accountId,
        aud: 'urn:qauth:aud:admin:v1-rc.0',
        client_id: 'plugin-github-e2e',
        token_use: 'access',
        scope: 'qauth:admin:read qauth:admin:write qauth:admin:security',
        jti: randomUUID(),
        iat: now,
        exp: now + 1800,
        cnf: { jkt: thumbprint(proofJwk) },
      },
      (input) => sign(null, input, signingKey)
    );
    return new Admin(realmId, accountId, token, proofKey, proofJwk);
  }

  /** A DPoP proof for one call (RFC 9449 §4.2). */
  private proof(method: string, path: string): string {
    return jws(
      { typ: 'dpop+jwt', alg: 'ES256', jwk: this.proofJwk },
      {
        jti: randomBytes(16).toString('base64url'),
        htm: method,
        htu: `${ADMIN_BASE_URL}${path}`,
        iat: Math.floor(Date.now() / 1000),
        ath: base64url(createHash('sha256').update(this.token, 'ascii').digest()),
      },
      (input) => sign('sha256', input, { key: this.proofKey, dsaEncoding: 'ieee-p1363' })
    );
  }

  /** One admin API call, below the realm; its status and JSON body. */
  async call(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    headers: Record<string, string> = {}
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const fullPath = `${ADMIN_PREFIX}/realms/${this.realmId}${path}`;
    const response = await fetch(`${ADMIN}${fullPath}`, {
      method,
      headers: {
        authorization: `DPoP ${this.token}`,
        dpop: this.proof(method, fullPath),
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
    };
  }

  /**
   * File an approval for a security operation and approve it. The approval
   * is written as approved straight into the database: the suite has no
   * passkey to approve it with. The server's gate checks it as it checks
   * any other.
   */
  async approved(operation: string, body: unknown): Promise<string> {
    const filed = await this.call('POST', '/approvals', {
      operation,
      params: { plugin: 'github' },
      body,
    });
    if (filed.status !== 201 || typeof filed.body['id'] !== 'string') {
      throw new Error(
        `approval for ${operation}: ${String(filed.status)} ${JSON.stringify(filed.body)}`
      );
    }
    const id = filed.body['id'];
    sql(
      `UPDATE admin_approvals SET status = 'approved', approvals = jsonb_build_array(jsonb_build_object(
         'approverRealmId', requester_realm_id::text, 'approverId', requester_id::text,
         'credentialId', 'plugin-github-e2e', 'factor', 'webauthn',
         'approvedAt', (extract(epoch FROM clock_timestamp()) * 1000)::bigint))
       WHERE id = ${literal(id)}`
    );
    return id;
  }
}
