import { describe, expect, it } from 'vitest';
import { latestOnly, loadAccessSafely } from './accessLoad';

// Shulim, 2026-11-11: a Super Admin landed on "Waiting for access" because a failed access request was read as
// "not a member". A failed request is now retried with a fresh session, and reported as expired or failed.
const ACCESS = { role: 'super_admin', org_id: 'oizer', is_platform_owner: true };
const answers = (...list: { data: unknown; error: { message: string; status?: number; code?: string } | null }[]) => {
  let i = 0;
  return () => Promise.resolve(list[Math.min(i++, list.length - 1)]);
};
const refreshOk = () => Promise.resolve({ data: { session: {} }, error: null });
const refreshFails = () => Promise.resolve({ data: { session: null }, error: { message: 'Invalid Refresh Token' } });

describe('loading access', () => {
  it('uses the answer when the request works', async () => {
    expect(await loadAccessSafely(answers({ data: ACCESS, error: null }), refreshFails)).toEqual({ kind: 'ok', access: ACCESS });
  });

  it('retries once with a refreshed session when the token had expired', async () => {
    const rpc = answers({ data: null, error: { message: 'JWT expired', code: 'PGRST301', status: 401 } }, { data: ACCESS, error: null });
    expect(await loadAccessSafely(rpc, refreshOk)).toEqual({ kind: 'ok', access: ACCESS });
  });

  it('says the session expired (back to sign-in) when it can’t be refreshed, instead of "no access"', async () => {
    const rpc = answers({ data: null, error: { message: 'JWT expired', status: 401 } });
    expect(await loadAccessSafely(rpc, refreshFails)).toEqual({ kind: 'expired' });
    expect(await loadAccessSafely(answers({ data: null, error: null }), refreshFails)).toEqual({ kind: 'expired' });
  });

  it('reports any other failure as a failure', async () => {
    const down = answers({ data: null, error: { message: 'Failed to fetch' } });
    expect(await loadAccessSafely(down, refreshFails)).toEqual({ kind: 'error', message: 'Failed to fetch' });
    expect(await loadAccessSafely(down, refreshOk)).toEqual({ kind: 'error', message: 'Failed to fetch' });
  });

  it('lets only the newest check decide', () => {
    const start = latestOnly();
    const first = start();
    const second = start();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });
});
