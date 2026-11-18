import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 240_000,
    hookTimeout: 120_000,
    // Browser-backed acceptance suites each launch Chromium; keep them from
    // starving each other of CPU, which would make layout timing noisy.
    fileParallelism: false,
    reporters: ['verbose'],
  },
});
