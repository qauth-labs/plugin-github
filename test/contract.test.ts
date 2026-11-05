/**
 * The plugin meets the AuthMethod contract, as QAuth's server holds a plugin
 * to it: the SDK's contract test kit, `checkAuthMethod`, with a fake GitHub
 * playing the provider.
 */
import { AUTH_METHOD_CONTRACT, AUTH_METHOD_PLUGIN_EXPORT } from '@qauth-labs/plugin-sdk';
import { checkAuthMethod } from '@qauth-labs/plugin-sdk/testing';
import { describe, expect, it } from 'vitest';

import * as plugin from '../src/index.js';
import { CONFIG, FakeGitHub } from './fake-github.js';

describe('the package', () => {
  it('exports its method as authMethod, written against the SDK’s contract', () => {
    expect(AUTH_METHOD_PLUGIN_EXPORT in plugin).toBe(true);
    expect(plugin.authMethod.contract).toBe(AUTH_METHOD_CONTRACT);
  });

  it('meets the AuthMethod contract for github.com', async () => {
    // Rejects with an AuthMethodContractError that lists every failed check.
    const report = await checkAuthMethod(plugin.authMethod, new FakeGitHub().scenario());
    expect(report.checks.length).toBeGreaterThan(0);
  });

  it('meets the AuthMethod contract for a GitHub Enterprise Server', async () => {
    const config = { ...CONFIG, baseUrl: 'https://github.corp.example' };
    await checkAuthMethod(plugin.authMethod, new FakeGitHub(config).scenario());
  });
});
