import { z } from 'zod';

/**
 * The plugin's config for one realm, and where GitHub answers for it.
 *
 * Without `baseUrl` the plugin signs people in at github.com. With it, at a
 * GitHub Enterprise Server: its web pages at the base URL, its REST API under
 * `/api/v3` there. A base URL that resolves to a private address works only
 * when the operator's egress allowlist names it for the realm: the plugin
 * makes every call through the egress client the server hands it.
 */

/** github.com: its web origin, which is also the issuer of its user ids. */
export const GITHUB_COM = 'https://github.com';

/** github.com's REST API. */
export const GITHUB_COM_API = 'https://api.github.com';

/**
 * A base URL: `https://` and a host name or IPv4 address, an optional port,
 * an optional trailing `/`, and nothing else (no credentials, path, query or
 * fragment). GitHub Enterprise Server answers at the root of its host.
 */
export const BASE_URL_PATTERN =
  /^https:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(?::[0-9]{1,5})?\/?$/;

/** The config an admin gives the plugin for one realm. */
export const configSchema = z.object({
  /** The client id of the GitHub OAuth app (or GitHub App) registered for this realm. */
  clientId: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[\x21-\x7e]+$/),
  /** Its client secret. Write-only: the server stores it encrypted and never shows it again. */
  clientSecret: z.string().min(1).max(1024).meta({ writeOnly: true }),
  /**
   * The base URL of a GitHub Enterprise Server, such as
   * `https://github.example.com`. Leave it out for github.com.
   */
  baseUrl: z
    .url({ protocol: /^https$/ })
    .max(270)
    .regex(BASE_URL_PATTERN)
    .optional(),
});

/** The parsed config. */
export type GitHubConfig = z.output<typeof configSchema>;

/** Where one GitHub answers. */
export interface GitHubEndpoints {
  /**
   * The issuer of the user ids: `https://github.com`, or the origin of the
   * Enterprise Server. A numeric id is unique only within it.
   */
  readonly issuer: string;
  /** The page the browser is sent to. */
  readonly authorize: string;
  /** Where the code is redeemed. */
  readonly token: string;
  /** The REST API's root, without a trailing `/`. */
  readonly api: string;
  /**
   * Who set the destinations, for the egress client: `operator` for
   * github.com when the config names no base URL (this package's own code
   * names it), `admin` for a base URL the realm's config names.
   */
  readonly source: 'operator' | 'admin';
}

/** The endpoints of the GitHub `config` names. */
export function endpointsOf(config: Pick<GitHubConfig, 'baseUrl'>): GitHubEndpoints {
  const origin = config.baseUrl === undefined ? GITHUB_COM : new URL(config.baseUrl).origin;
  if (origin === GITHUB_COM) {
    return {
      issuer: GITHUB_COM,
      authorize: `${GITHUB_COM}/login/oauth/authorize`,
      token: `${GITHUB_COM}/login/oauth/access_token`,
      api: GITHUB_COM_API,
      source: config.baseUrl === undefined ? 'operator' : 'admin',
    };
  }
  return {
    issuer: origin,
    authorize: `${origin}/login/oauth/authorize`,
    token: `${origin}/login/oauth/access_token`,
    api: `${origin}/api/v3`,
    source: 'admin',
  };
}
