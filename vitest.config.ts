import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Excluded: pure I/O adapters with no branching logic to unit-guard.
      // They are exercised end to end by the real sync, and mocking the
      // googleapis method chain to "test" a one-line wrapper is brittle and
      // low-signal. The pure pieces (request builders in client.ts, the schema
      // in database.ts) are covered by sheets-client / repository / migrations
      // tests regardless of the % denominator.
      exclude: [
        'src/index.ts',            // CLI entrypoint
        'src/scheduler.ts',        // cron entrypoint
        'src/**/index.ts',         // barrel re-exports
        'src/sheets/client.ts',    // thin googleapis wrapper (builders tested separately)
        'src/sheets/setup.ts',     // live spreadsheet creation + seeding
        'src/storage/database.ts', // connection factory (schema tested via migrations)
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
  },
});
