import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

// Backstop for tests that load the Supabase client (it refuses to start without these two settings). CI sets the
// real public values; locally they come from .env.local. Only when neither has them, harmless placeholders are
// used: no test talks to Supabase, and no secret or service-role key is ever needed here.
const fileEnv = loadEnv('test', process.cwd(), 'VITE_');
const fallback = (name: string, value: string) => (process.env[name] || fileEnv[name] ? {} : { [name]: value });

export default defineConfig({
  test: {
    include: ['supabase/tests/**/*.test.ts', 'src/**/*.test.ts', 'workers/**/*.test.ts', 'functions/**/*.test.ts', 'supabase/functions/**/*.test.ts', 'scripts/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Each test builds its own in-memory database; too many files at once runs out of memory.
    maxWorkers: 6,
    env: {
      ...fallback('VITE_SUPABASE_URL', 'https://placeholder.supabase.co'),
      ...fallback('VITE_SUPABASE_ANON_KEY', 'placeholder-anon-key-for-tests'),
    },
  },
});
