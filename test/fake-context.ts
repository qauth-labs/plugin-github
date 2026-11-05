/**
 * The context the server hands the method, faked for the unit tests: the
 * config, the egress client (answered by a fake GitHub), a signer the plugin
 * never needs, a logger that keeps every line, and `routeUrl` on a test
 * realm. The contract test kit builds the server's own context instead.
 */
import type {
  AuthMethodContext,
  AuthMethodEgressRequest,
  AuthMethodEgressResponse,
} from '@qauth-labs/plugin-sdk';

import type { GitHubConfig } from '../src/config.js';

/** The realm's origin in the unit tests. */
export const REALM_ORIGIN = 'https://realm.test';

/** One log line the method wrote. */
export interface LogLine {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly fields: Record<string, unknown>;
  readonly message: string;
}

export interface FakeContext extends AuthMethodContext<GitHubConfig> {
  readonly lines: LogLine[];
}

export function fakeContext(
  config: GitHubConfig,
  egress: (
    request: AuthMethodEgressRequest
  ) => AuthMethodEgressResponse | Promise<AuthMethodEgressResponse>
): FakeContext {
  const lines: LogLine[] = [];
  const logAt =
    (level: LogLine['level']) =>
    (fields: Record<string, unknown>, message: string): void => {
      lines.push({ level, fields, message });
    };
  return {
    config,
    lines,
    egress: { request: async (request) => egress(request) },
    signer: {
      signClientAssertion: () => Promise.reject(new Error('the plugin signs nothing')),
      getUpstreamJwks: () => Promise.reject(new Error('the plugin signs nothing')),
    },
    log: { debug: logAt('debug'), info: logAt('info'), warn: logAt('warn'), error: logAt('error') },
    routeUrl: (path) => `${REALM_ORIGIN}/upstream/github${path}`,
  };
}
