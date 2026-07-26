import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
    setupFiles: [
      // Blocks non-localhost fetch so no test depends on real provider latency.
      './src/__tests__/helpers/offline-fetch.ts',
      // Keeps `listen(0)` off the ports fetch() refuses outright.
      './src/__tests__/helpers/fetchable-port.ts',
    ],
  },
});
