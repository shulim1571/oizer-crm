import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['supabase/tests/**/*.test.ts', 'src/**/*.test.ts', 'workers/**/*.test.ts', 'functions/**/*.test.ts', 'supabase/functions/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Each test builds its own in-memory database; too many files at once runs out of memory.
    maxWorkers: 6,
  },
});
