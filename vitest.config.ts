import { defineConfig } from 'vitest/config';

// The unit tests and the contract test kit. The end-to-end suite has its own
// config (e2e/vitest.config.ts): it needs the containers.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
