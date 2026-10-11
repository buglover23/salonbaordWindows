import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Integration tests spawn the CLI and run the dry-run pipeline; the 5 s default is too tight under a full parallel run.
    testTimeout: 20_000,
    // Run outside JST so host local-time leakage fails on the JST dev machine too (tests/unit/shared/tz-guard.test.ts).
    env: { TZ: 'America/Los_Angeles' },
  },
});
