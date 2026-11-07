# @qauth-labs/plugin-github

> **Experimental.** This plugin runs on QAuth's experimental plugin API. QAuth
> loads it only while `PLUGIN_API_ENABLED=true`, and the API, the contract and
> this package may change before QAuth 1.0. Do not rely on it for production
> sign-in yet.

Sign-in with GitHub for [QAuth](https://github.com/qauth-labs/qauth), as an
AuthMethod plugin. A realm that enables it offers "GitHub" as an upstream
sign-in: the person signs in on GitHub (or a GitHub Enterprise Server), and
QAuth signs them into the account that belongs to their GitHub user id.
Applications keep receiving QAuth's own OAuth 2.1 and OpenID Connect tokens.

The plugin is made and released by the QAuth project, in its own repository,
the way a third party writes a plugin: it depends only on the published
[`@qauth-labs/plugin-sdk`](https://www.npmjs.com/package/@qauth-labs/plugin-sdk)
and has its own version line.

## Compatibility

| Plugin       | QAuth server                    | AuthMethod contract        | Plugin SDK   |
| ------------ | ------------------------------- | -------------------------- | ------------ |
| `0.1.0`      | `0.2.0` and later on `0.2`      | `qauth-auth-method/1-rc.0` | `0.2.0`      |
| `0.1.0-rc.0` | `0.2.0-rc.1` and later on `0.2` | `qauth-auth-method/1-rc.0` | `0.2.0-rc.1` |

## How it signs a person in

GitHub has no OpenID Connect sign-in: it issues no ID token and takes no
`nonce`. The plugin uses OAuth 2.0 and GitHub's REST API instead.

1. **Authorization request.** The plugin sends the browser to
   `/login/oauth/authorize` with a fresh `state` and a PKCE challenge
   (S256), asking for the `user:email` scope and nothing else. The
   `redirect_uri` is this provider's own callback,
   `https://<realm host>/upstream/github/callback`.
2. **Callback.** QAuth checks the returned `state` against the sign-in's flow
   cookie before the plugin runs; the plugin checks it once more. With no ID
   token, the `state`, the flow cookie and a callback URL that only this
   provider uses are what tie GitHub's answer to the sign-in that asked for
   it.
3. **Token exchange.** The code is redeemed at `/login/oauth/access_token`
   with the PKCE verifier, the client id and secret, asking for JSON
   (`Accept: application/json`).
4. **The person.** With the access token, the plugin reads `GET /user` (the
   numeric id, the login, the display name) and `GET /user/emails` (the
   addresses, which is what `user:email` allows). Then it drops the token.

**The account is the numeric GitHub user id**, under the GitHub instance that
issued it (`https://github.com`, or the Enterprise Server's base URL). It is
never the login name: a login can be renamed and then taken by someone else.
A renamed login, or a changed email address, signs in the same account.

**Attributes.** When the account is created, QAuth stores:

| Attribute            | From                                      | Verified                                    |
| -------------------- | ----------------------------------------- | ------------------------------------------- |
| `email`              | the address GitHub marks **primary**      | only when GitHub also marks it **verified** |
| `preferred_username` | the login name                            | never                                       |
| `name`               | the display name, when the person set one | never                                       |

Only the primary address is taken. An address that is verified but not
primary is not used, and a list with no primary address, or two, gives no
email at all.

**The access token** is used for the two reads of one sign-in, and nowhere
else. It is never stored, logged or handed to QAuth. Each call that carries a
credential (the code and the client secret, or the access token) follows no
redirect.

**Outbound calls.** Every call goes through the egress client QAuth hands the
plugin, never a network API of its own; the plugin holds no key.

### PKCE

The plugin always sends PKCE with S256 and the verifier at the token endpoint.

- **github.com** accepts PKCE (S256) for OAuth apps and GitHub Apps since
  GitHub's changelog of 2025-07-14, in the
  [web application flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#web-application-flow).
  It checks the verifier when the authorization request carried a challenge.
- **GitHub Enterprise Server** releases from before that change do not
  support PKCE; they ignore the parameters they do not know (RFC 6749 §3.1).
  There the sign-in rests on `state`, the flow cookie and the client secret,
  as it did before PKCE. Check your release's documentation.

The end-to-end suite runs against a mock that enforces PKCE the way
github.com does. It has not been run against github.com itself in CI, which
would need a real account.

## Install it (operators)

You need QAuth `0.2.0` or later, and an image you build on top of
QAuth's released one.

### 1. Register the app on GitHub

Create an OAuth app (or a GitHub App) on github.com or on your Enterprise
Server:

- **Callback URL**: `https://<realm host>/upstream/github/callback`, one per
  realm host.
- **OAuth app**: nothing else to set. The plugin asks for `user:email`.
- **GitHub App**: give it the account permission **Email addresses: read-only**
  and no other permission.

Keep the client id and generate a client secret.

### 2. Add the package to the server image

The image is a self-contained tree under `/app`. Install the plugin into a
separate stage, nested, so it brings its own copy of the plugin SDK, and copy
it in. `--omit=peer` makes it use the server's own `zod`; `--ignore-scripts`
runs no install script. Pin the server image by digest and the plugin by
version, and install from a lockfile you have read, so every build gets the
same dependency tree. Write the lockfile once, in a `plugins/` directory of
your build context, without installing anything:

```bash
mkdir plugins && cd plugins
npm init --yes > /dev/null
npm install --package-lock-only --save-exact --omit=dev --omit=peer \
  --install-strategy=nested --ignore-scripts @qauth-labs/plugin-github@0.1.0
```

Read `package-lock.json` and commit both files. Then:

```dockerfile
ARG QAUTH_IMAGE=ghcr.io/qauth-labs/qauth/auth-server:0.2.0@sha256:<digest>

# The build stage writes the files the server will run: pin it by digest too.
FROM node:26-alpine@sha256:<digest> AS plugin
WORKDIR /plugin
COPY plugins/package.json plugins/package-lock.json ./
RUN npm ci --omit=dev --omit=peer --install-strategy=nested --ignore-scripts

FROM ${QAUTH_IMAGE}
COPY --from=plugin --chown=nodejs:nodejs \
  /plugin/node_modules/@qauth-labs/plugin-github \
  /app/node_modules/@qauth-labs/plugin-github
```

Rebuild it at every QAuth upgrade, with the lockfile moved to the plugin
version made for that release by the same `npm install --package-lock-only`.
To know the package was built by this
repository's release workflow, read the version's provenance on npmjs.com,
or the attestation at
`npm view @qauth-labs/plugin-github@<version> dist.attestations.url`, and
check that it names `qauth-labs/plugin-github` and
`.github/workflows/release.yml`. `npm audit signatures` alone checks that the
signatures and attestations are valid, not who built the package. QAuth's
own docs describe the recipe
under "Operate → Images → Add a plugin to the image".

### 3. Turn it on

```sh
AUTH_METHOD_PLUGINS=@qauth-labs/plugin-github
PLUGIN_API_ENABLED=true
```

The boot logs `AuthMethod plugin @qauth-labs/plugin-github loaded: github (github)`.
With `PLUGIN_API_ENABLED` off, the server does not load it and logs why:
`The AuthMethod plugin @qauth-labs/plugin-github is not loaded: it is not a
first-party plugin, and the experimental plugin API is off. …`

### 4. Configure it for a realm

Through QAuth's admin API, per realm (`{realm}` is the realm's id, `github`
the plugin's name):

1. Seal the client secret:
   `POST /admin/v1-rc.0/realms/{realm}/plugins/github/secrets/seal` with
   `{"path": "clientSecret", "value": "<client secret>"}`. The answer's
   `sealed` value is what the server stores; the secret itself never is.
2. Set the configuration:
   `POST /admin/v1-rc.0/realms/{realm}/plugins/github/config` with
   `{"version": <current version>, "config": {"clientId": "<client id>"}, "secrets": {"clientSecret": {"sealed": "<sealed>"}}}`.
   Add `"baseUrl"` to `config` for an Enterprise Server.
3. Enable it: `POST /admin/v1-rc.0/realms/{realm}/plugins/github/enable` with
   `{"version": <current version>}`.

Setting the configuration and enabling the plugin are security operations:
each needs an approval (`QAuth-Approval` header), as QAuth's admin API
documentation describes.

| Setting        | Required | What it is                                                                               |
| -------------- | -------- | ---------------------------------------------------------------------------------------- |
| `clientId`     | yes      | The app's client id.                                                                     |
| `clientSecret` | yes      | The app's client secret. Write-only: sealed by the server, never shown again.            |
| `baseUrl`      | no       | An Enterprise Server's address, `https://host[:port]`, no path. Absent means github.com. |

Once enabled, the realm's sign-in offers GitHub, and an application can send
the browser straight to it with `qauth_upstream=github` on
`/oauth/authorize`. A first sign-in creates an account when the realm allows
sign-up.

### GitHub Enterprise Server

Set `baseUrl` to the server's address, for example
`https://github.corp.example`. The plugin then uses
`<baseUrl>/login/oauth/authorize`, `<baseUrl>/login/oauth/access_token` and
the REST API at `<baseUrl>/api/v3`. Accounts are keyed under that address,
so the same numeric id on github.com and on your server are two different
people.

QAuth's egress client refuses private addresses (RFC 1918, unique-local and
the like). If your server is on a private address, the operator names it, for
the realms that may reach it, in the allowlist file `EGRESS_ALLOWLIST_PATH`
points at:

```json
{
  "entries": [{ "host": "github.corp.example", "realms": ["master"] }]
}
```

Without that entry, a sign-in through that server fails with "We could not
sign you in", and the server logs `egress call blocked`.

## Develop

The repository uses QAuth's own toolchain: Node 26, pnpm (the version in
`package.json`'s `packageManager`), TypeScript, Oxlint, Oxfmt and Vitest.
pnpm resolves a dependency version only once it has been on the registry
for 7 days (`pnpm-workspace.yaml`), as QAuth does.

```sh
pnpm install
pnpm run lint && pnpm run format:check && pnpm run typecheck && pnpm test
```

`pnpm test` runs the unit tests against a fake GitHub, and the plugin SDK's
contract test kit (`checkAuthMethod`), for github.com and for an Enterprise
Server.

The end-to-end suite needs docker, openssl, Node and pnpm:

```sh
pnpm run e2e
```

It packs the plugin, builds QAuth's released server image with the plugin
added as above, starts it with PostgreSQL, Redis and a mock GitHub
Enterprise Server, configures the plugin through the admin API and signs in
through the server's pages. It checks that:

- the first sign-in creates an account keyed by the numeric id;
- a renamed login, and a changed email address, sign in the same account;
- only a primary and verified email becomes a verified attribute;
- the access token is not in the database, the logs or the events;
- a callback with a wrong `state` is refused;
- a private base URL is refused unless the allowlist names it;
- with `PLUGIN_API_ENABLED` off, the boot skips the plugin and says why.

CI runs both on every pull request. Releases are described in
[RELEASING.md](RELEASING.md).

## License

[Apache-2.0](LICENSE)
