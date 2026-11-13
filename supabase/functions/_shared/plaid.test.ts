import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { plaidConfig, plaidError, toSyncLines } from './plaid';

// Plaid sandbox (Shulim, 2026-11-11) and production (approved 2026-11-13). Keys come only from settings and never appear in messages or code.
const env = (vars: Record<string, string | undefined>) => (n: string) => vars[n];
const FAKE_ID = 'test-client-id-not-real';
const FAKE_SECRET = 'test-secret-not-real-0123456789';

describe('Plaid settings', () => {
  it('reads both keys from the environment and defaults to the sandbox', () => {
    const c = plaidConfig(env({ PLAID_CLIENT_ID: FAKE_ID, PLAID_SANDBOX_SECRET: FAKE_SECRET }));
    expect(c).toEqual({ ok: true, clientId: FAKE_ID, secret: FAKE_SECRET, env: 'sandbox', baseUrl: 'https://sandbox.plaid.com' });
    expect(plaidConfig(env({ PLAID_CLIENT_ID: FAKE_ID, PLAID_SANDBOX_SECRET: FAKE_SECRET, PLAID_ENV: 'Sandbox' })).ok).toBe(true);
  });

  it('uses the production secret and address when PLAID_ENV is production (Shulim, 2026-11-13)', () => {
    const c = plaidConfig(env({ PLAID_CLIENT_ID: FAKE_ID, PLAID_SANDBOX_SECRET: 'sandbox-not-used', PLAID_PRODUCTION_SECRET: FAKE_SECRET, PLAID_ENV: 'production' }));
    expect(c).toEqual({ ok: true, clientId: FAKE_ID, secret: FAKE_SECRET, env: 'production', baseUrl: 'https://production.plaid.com' });
    // The sandbox keeps using its own secret.
    const sb = plaidConfig(env({ PLAID_CLIENT_ID: FAKE_ID, PLAID_SANDBOX_SECRET: FAKE_SECRET, PLAID_PRODUCTION_SECRET: 'production-not-used' }));
    expect(sb.ok && sb.secret).toBe(FAKE_SECRET);
    expect(sb.ok && sb.baseUrl).toBe('https://sandbox.plaid.com');
  });

  it('refuses any other environment, and production without its own secret', () => {
    for (const e of ['development', 'live']) {
      const c = plaidConfig(env({ PLAID_CLIENT_ID: FAKE_ID, PLAID_SANDBOX_SECRET: FAKE_SECRET, PLAID_PRODUCTION_SECRET: FAKE_SECRET, PLAID_ENV: e }));
      expect(c.ok).toBe(false);
      if (!c.ok) expect(c.error).toMatch(/PLAID_ENV has to be sandbox or production/);
    }
    const noProd = plaidConfig(env({ PLAID_CLIENT_ID: FAKE_ID, PLAID_SANDBOX_SECRET: FAKE_SECRET, PLAID_ENV: 'production' }));
    expect(noProd).toEqual({ ok: false, error: "Plaid isn't set up yet: PLAID_PRODUCTION_SECRET is missing." });
  });

  it('names a missing setting without showing any value', () => {
    const c = plaidConfig(env({ PLAID_CLIENT_ID: FAKE_ID }));
    expect(c).toEqual({ ok: false, error: "Plaid isn't set up yet: PLAID_SANDBOX_SECRET is missing." });
    const none = plaidConfig(env({}));
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.error).toMatch(/PLAID_CLIENT_ID and PLAID_SANDBOX_SECRET are missing/);
    const bad = plaidConfig(env({ PLAID_CLIENT_ID: FAKE_ID, PLAID_SANDBOX_SECRET: FAKE_SECRET, PLAID_ENV: 'development' }));
    expect(JSON.stringify(bad)).not.toContain(FAKE_SECRET);
    expect(JSON.stringify(bad)).not.toContain(FAKE_ID);
  });

  it('shows Plaid’s own error words, never what was sent', () => {
    expect(plaidError({ error_message: 'the provided public token is invalid', error_code: 'INVALID_PUBLIC_TOKEN' }, 400))
      .toBe('Plaid: the provided public token is invalid (INVALID_PUBLIC_TOKEN)');
    expect(plaidError(null, 502)).toBe("Plaid didn't answer (502).");
  });
});

describe('Plaid transactions as bank lines', () => {
  it('keeps the linked account’s posted transactions, deposits positive', () => {
    const lines = toSyncLines([
      { transaction_id: 't1', account_id: 'acc', amount: 25.5, date: '2026-11-02', name: 'Uber 063015 SF**POOL**', merchant_name: 'Uber' },
      { transaction_id: 't2', account_id: 'acc', amount: -1000, date: '2026-11-03', name: 'CD DEPOSIT .INITIAL.' },
      { transaction_id: 't3', account_id: 'acc', amount: 12, date: '2026-11-04', name: 'Pending', pending: true },
      { transaction_id: 't4', account_id: 'other', amount: 5, date: '2026-11-04', name: 'Other account' },
      { transaction_id: 't5', account_id: 'acc', amount: 1200, date: '2026-11-05', name: 'CHECK 1234', check_number: '1234' },
    ], 'acc');
    expect(lines).toEqual([
      { id: 't1', date: '2026-11-02', amount: -25.5, description: 'Uber', check_number: null },
      { id: 't2', date: '2026-11-03', amount: 1000, description: 'CD DEPOSIT .INITIAL.', check_number: null },
      { id: 't5', date: '2026-11-05', amount: -1200, description: 'CHECK 1234', check_number: '1234' },
    ]);
  });
});

describe('no Plaid key in the code', () => {
  it('reads keys only from settings and never logs', () => {
    const fn = readFileSync('supabase/functions/plaid/index.ts', 'utf8');
    const shared = readFileSync('supabase/functions/_shared/plaid.ts', 'utf8');
    expect(fn).toContain("plaidConfig(n => Deno.env.get(n))");
    expect(fn + shared).not.toMatch(/console\.(log|info|debug|warn|error)/);
    // Plaid client ids are 24 hex characters and secrets 30; nothing like either is written into the code.
    expect(fn + shared).not.toMatch(/['"][0-9a-f]{24}['"]|['"][0-9a-f]{30}['"]/);
    expect(readFileSync('.gitignore', 'utf8')).toMatch(/^\.env$/m);
  });
});
