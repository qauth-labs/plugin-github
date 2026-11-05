/**
 * `@qauth-labs/plugin-github` — GitHub sign-in for QAuth, as an AuthMethod
 * plugin. EXPERIMENTAL, like the plugin API it is written against.
 *
 * The operator installs the package with the deployment, lists it in
 * `AUTH_METHOD_PLUGINS` and turns on `PLUGIN_API_ENABLED`; each realm then
 * enables and configures it through the admin API. See the README.
 *
 * @packageDocumentation
 */
export {
  BASE_URL_PATTERN,
  configSchema,
  endpointsOf,
  GITHUB_COM,
  GITHUB_COM_API,
  type GitHubConfig,
  type GitHubEndpoints,
} from './config.js';
export { GITHUB_API_VERSION, GITHUB_SCOPE } from './github.js';
export { authMethod, CALLBACK_PATH, GITHUB_TYPE, type GitHubTransaction } from './method.js';
