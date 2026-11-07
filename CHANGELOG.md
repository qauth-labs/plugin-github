# Changelog

All notable changes to `@qauth-labs/plugin-github` are recorded here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The
package has its own version line, separate from QAuth's: 0.x while QAuth's
plugin API is experimental, with a `-rc.N` release candidate before each
release (RELEASING.md).

## [Unreleased]

## [0.1.0] - 2026-11-07

The first release, on npm's `latest` dist-tag. Experimental: QAuth loads it
only with `PLUGIN_API_ENABLED=true`, and its plugin API may change before
QAuth 1.0.

### Changed

- For QAuth 0.2.0 and later on the 0.2 line. The plugin depends on the
  released `@qauth-labs/plugin-sdk` `0.2.0` instead of its release candidate
  `0.2.0-rc.1`. The AuthMethod contract is unchanged,
  `qauth-auth-method/1-rc.0`.
- The end-to-end suite runs against QAuth's released `0.2.0` server and
  migration-runner images, pinned by digest.

## [0.1.0-rc.0]

The first release candidate. Experimental: QAuth loads it only with
`PLUGIN_API_ENABLED=true`, and its plugin API may change before QAuth 1.0.

### Added

- Sign-in with GitHub as a QAuth AuthMethod plugin (contract
  `qauth-auth-method/1-rc.0`), for QAuth 0.2.0-rc.1 and later on the 0.2 line.
  It depends only on `@qauth-labs/plugin-sdk`.
- The OAuth 2.0 authorization code flow with `state` and PKCE (S256), on a
  callback URL of this provider alone (`/upstream/github/callback`). The code
  is redeemed at the token endpoint asking for JSON.
- The person is read from `GET /user` and `GET /user/emails`, with the
  `user:email` scope and nothing more. The account is keyed by the numeric
  user id under the GitHub instance that issued it, never by the login name.
- The email address becomes a verified attribute only when GitHub marks it
  both primary and verified. The login name and the display name are stored
  as unverified attributes.
- The access token is used for those two reads of one sign-in and dropped:
  it is never stored, logged or handed to the server.
- A `baseUrl` for GitHub Enterprise Server. A private address is reached only
  when the operator's egress allowlist names it for the realm.
- CI with the plugin SDK's contract test kit, and an end-to-end suite that
  runs the released QAuth server image with the plugin installed, against a
  mock GitHub.
- A release workflow that stages the package on npm through trusted
  publishing, for a maintainer's approval with 2FA.

[Unreleased]: https://github.com/qauth-labs/plugin-github/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/qauth-labs/plugin-github/compare/v0.1.0-rc.0...v0.1.0
[0.1.0-rc.0]: https://github.com/qauth-labs/plugin-github/releases/tag/v0.1.0-rc.0
