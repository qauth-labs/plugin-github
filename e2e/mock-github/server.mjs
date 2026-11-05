/**
 * A mock GitHub Enterprise Server for the end-to-end suite, over https: the
 * authorization page, the token endpoint, `GET /api/v3/user` and
 * `GET /api/v3/user/emails`, answering as GitHub does. It checks what GitHub
 * checks: the client, the code (good once), the `redirect_uri`, the PKCE
 * verifier, the bearer token and the `User-Agent`.
 *
 * The test drives it through a control API under `/_control/`: it sets the
 * person who signs in next, and reads back every access token the mock
 * issued and every call it answered, so it can look for those tokens in the
 * server's database and logs.
 *
 * No dependencies: it runs on the plain node image.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';

const PORT = Number(process.env.PORT ?? '8443');
const CLIENT_ID = process.env.MOCK_GITHUB_CLIENT_ID ?? '';
const CLIENT_SECRET = process.env.MOCK_GITHUB_CLIENT_SECRET ?? '';
if (CLIENT_ID === '' || CLIENT_SECRET === '') {
  throw new Error('MOCK_GITHUB_CLIENT_ID and MOCK_GITHUB_CLIENT_SECRET are required');
}

/** The person who signs in at the authorization page. The test replaces it. */
let person = {
  id: 1001,
  login: 'first-person',
  name: 'First Person',
  emails: [{ email: 'first@example.com', primary: true, verified: true, visibility: 'private' }],
};

/** Issued codes: the request they answer, and the person as they were then. */
const codes = new Map();
/** Issued access tokens and the person each belongs to. */
const people = new Map();
/** Every access token issued, in order. */
const tokens = [];
/** Every call answered, without its credentials: method, host and path. */
const calls = [];

function s256(verifier) {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

function same(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
}

async function bodyOf(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function authorize(url, response) {
  const query = url.searchParams;
  const redirectUri = query.get('redirect_uri');
  const state = query.get('state');
  if (query.get('client_id') !== CLIENT_ID || redirectUri === null || state === null) {
    return json(response, 400, { message: 'not a request of the registered app' });
  }
  const code = randomBytes(10).toString('hex');
  codes.set(code, {
    redirectUri,
    challenge: query.get('code_challenge'),
    challengeMethod: query.get('code_challenge_method'),
    person: structuredClone(person),
  });
  const back = new URL(redirectUri);
  back.searchParams.set('code', code);
  back.searchParams.set('state', state);
  response.writeHead(302, { location: back.href });
  response.end();
}

function token(request, form, response) {
  // GitHub answers JSON only when asked; the plugin asks.
  if (!(request.headers.accept ?? '').includes('application/json')) {
    response.writeHead(200, { 'content-type': 'application/x-www-form-urlencoded' });
    return response.end('error=not_asked_for_json');
  }
  if (
    !same(form.get('client_id') ?? '', CLIENT_ID) ||
    !same(form.get('client_secret') ?? '', CLIENT_SECRET)
  ) {
    return json(response, 200, { error: 'incorrect_client_credentials' });
  }
  const code = form.get('code') ?? '';
  const issued = codes.get(code);
  codes.delete(code);
  if (issued === undefined) return json(response, 200, { error: 'bad_verification_code' });
  if (form.get('redirect_uri') !== issued.redirectUri) {
    return json(response, 200, { error: 'redirect_uri_mismatch' });
  }
  if (issued.challenge !== null) {
    const verifier = form.get('code_verifier') ?? '';
    if (issued.challengeMethod !== 'S256' || !same(s256(verifier), issued.challenge)) {
      return json(response, 200, { error: 'bad_verification_code' });
    }
  }
  const accessToken = `gho_${randomBytes(27).toString('base64url')}`;
  tokens.push(accessToken);
  people.set(accessToken, issued.person);
  return json(response, 200, {
    access_token: accessToken,
    token_type: 'bearer',
    scope: 'user:email',
  });
}

function bearer(request) {
  const header = request.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? people.get(header.slice('Bearer '.length)) : undefined;
}

function api(request, url, response) {
  if (request.headers['user-agent'] === undefined) {
    return json(response, 403, { message: 'Request forbidden by administrative rules.' });
  }
  const signedIn = bearer(request);
  if (signedIn === undefined) return json(response, 401, { message: 'Bad credentials' });
  if (url.pathname === '/api/v3/user') {
    return json(response, 200, {
      login: signedIn.login,
      id: signedIn.id,
      node_id: `U_${String(signedIn.id)}`,
      type: 'User',
      name: signedIn.name,
      email: null,
    });
  }
  return json(response, 200, signedIn.emails);
}

async function control(request, url, response) {
  if (request.method === 'PUT' && url.pathname === '/_control/person') {
    person = JSON.parse(await bodyOf(request));
    return json(response, 200, person);
  }
  if (request.method === 'GET' && url.pathname === '/_control/tokens') {
    return json(response, 200, { tokens });
  }
  if (request.method === 'GET' && url.pathname === '/_control/calls') {
    return json(response, 200, { calls });
  }
  return json(response, 404, { message: 'Not Found' });
}

const tls = {
  key: readFileSync(process.env.TLS_KEY ?? '/certs/mock.key'),
  cert: readFileSync(process.env.TLS_CERT ?? '/certs/mock.crt'),
};

createServer(tls, (request, response) => {
  const url = new URL(request.url ?? '/', 'https://mock-github');
  if (url.pathname.startsWith('/_control/')) {
    control(request, url, response).catch(() =>
      json(response, 400, { message: 'bad control call' })
    );
    return;
  }
  calls.push({ method: request.method, host: request.headers.host ?? '', path: url.pathname });
  if (request.method === 'GET' && url.pathname === '/login/oauth/authorize') {
    return authorize(url, response);
  }
  if (request.method === 'POST' && url.pathname === '/login/oauth/access_token') {
    bodyOf(request)
      .then((text) => token(request, new URLSearchParams(text), response))
      .catch(() => json(response, 400, { message: 'bad request' }));
    return;
  }
  if (
    request.method === 'GET' &&
    (url.pathname === '/api/v3/user' || url.pathname === '/api/v3/user/emails')
  ) {
    return api(request, url, response);
  }
  return json(response, 404, { message: 'Not Found' });
}).listen(PORT, '0.0.0.0', () => {
  console.log(`mock GitHub listening on ${String(PORT)}`);
});
