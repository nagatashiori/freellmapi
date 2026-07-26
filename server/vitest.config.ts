import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
    // Blocks non-localhost fetch so no test depends on real provider latency.
    setupFiles: ['./src/__tests__/helpers/offline-fetch.ts'],
  },
});
