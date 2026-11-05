import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'coverage/'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    rules: {
      // The AuthMethod contract's members are async by their type; one that
      // has nothing to wait for is still async.
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      // Every outbound call goes through the egress client the server hands
      // the plugin (ADR-019 Decision 8), never a network API of its own.
      'no-restricted-globals': [
        'error',
        {
          name: 'fetch',
          message: 'Use context.egress: every call goes through the egress client.',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            'node:http',
            'node:https',
            'node:net',
            'node:tls',
            'http',
            'https',
            'net',
            'tls',
            'undici',
          ].map((name) => ({
            name,
            message: 'Use context.egress: every call goes through the egress client.',
          })),
        },
      ],
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // The plain-JavaScript files (this config, the mock GitHub) run on Node.
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      globals: Object.fromEntries(
        ['Buffer', 'URL', 'URLSearchParams', 'console', 'process', 'structuredClone'].map(
          (name) => [name, 'readonly']
        )
      ),
    },
  },
  prettier
);
