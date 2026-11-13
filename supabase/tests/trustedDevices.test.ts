import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, MANAGER_1, as, seededDb } from './harness';

// Moshe Henig, 2026-11-11: a trusted device or recognized address skips the sign-in code; new ones still need it.
const TOKEN = 'a'.repeat(43);
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
// Runs as a password-only session (aal1), from the given address.
const call = <T,>(db: PGlite, user: string, session: string, ip: string, q: string, p: unknown[] = []) =>
  as(db, user, async tx => {
    const headers = JSON.parse((await tx.query<{ h: string }>(`select current_setting('request.headers', true) h`)).rows[0].h || '{}');
    await tx.query(`select set_config('request.headers', $1, true)`, [JSON.stringify({ ...headers, 'x-forwarded-for': ip })]);
    return (await tx.query<T>(q, p)).rows[0];
  }, undefined, 'aal1', session);
const ok = (db: PGlite, user: string, session: string) => call<{ ok: boolean }>(db, user, session, '9.9.9.9', `select public.mfa_ok() ok`);

describe('trusted devices for two-step verification', () => {
  let db: PGlite;
  beforeEach(async () => {
    db = await seededDb();
    // ADMIN verified this session with a code (as a phone code would record it) and trusted the device.
    await db.query(`insert into public.mfa_phone_sessions (session_id, user_id) values ($1, $2)`, [S1, ADMIN]);
    await call(db, ADMIN, S1, '1.2.3.4', `select public.mfa_trust_this_device($1, 'test browser')`, [TOKEN]);
  });

  it('let a trusted device sign in again without a code, for that session', async () => {
    expect((await ok(db, ADMIN, S2)).ok).toBe(false);
    expect((await call<{ how: string }>(db, ADMIN, S2, '5.5.5.5', `select public.mfa_use_trusted($1) how`, [TOKEN])).how).toBe('device');
    expect((await ok(db, ADMIN, S2)).ok).toBe(true);
  });

  it('recognize the same address within 7 days, but not a new device on a new address', async () => {
    expect((await call<{ how: string }>(db, ADMIN, S2, '1.2.3.4', `select public.mfa_use_trusted($1) how`, ['b'.repeat(43)])).how).toBe('address');
    const db2 = await seededDb();
    await db2.query(`insert into public.mfa_phone_sessions (session_id, user_id) values ($1, $2)`, [S1, ADMIN]);
    await call(db2, ADMIN, S1, '1.2.3.4', `select public.mfa_trust_this_device($1, null)`, [TOKEN]);
    expect((await call<{ how: string | null }>(db2, ADMIN, S2, '8.8.8.8', `select public.mfa_use_trusted($1) how`, ['b'.repeat(43)])).how).toBeNull();
    await db2.query(`update public.mfa_trusted_devices set created_at = now() - interval '8 days'`);
    expect((await call<{ how: string | null }>(db2, ADMIN, S2, '1.2.3.4', `select public.mfa_use_trusted($1) how`, ['b'.repeat(43)])).how).toBeNull();
  });

  it('expire after 30 days, belong to one person only, and can be forgotten', async () => {
    expect((await call<{ how: string | null }>(db, MANAGER_1, S2, '1.2.3.4', `select public.mfa_use_trusted($1) how`, [TOKEN])).how).toBeNull();
    await db.query(`update public.mfa_trusted_devices set expires_at = now() - interval '1 minute'`);
    expect((await call<{ how: string | null }>(db, ADMIN, S2, '5.5.5.5', `select public.mfa_use_trusted($1) how`, [TOKEN])).how).toBeNull();
    await db.query(`update public.mfa_trusted_devices set expires_at = now() + interval '30 days'`);
    expect((await call<{ n: number }>(db, ADMIN, S2, '5.5.5.5', `select public.mfa_forget_devices() n`)).n).toBe(1);
    expect((await call<{ how: string | null }>(db, ADMIN, S2, '5.5.5.5', `select public.mfa_use_trusted($1) how`, [TOKEN])).how).toBeNull();
  });

  it('can only be set up after a code in this session, and store no raw token', async () => {
    await expect(call(db, ADMIN, S2, '1.2.3.4', `select public.mfa_trust_this_device($1, null)`, ['c'.repeat(43)])).rejects.toThrow(/verification code first/);
    expect((await db.query<{ n: number }>(`select count(*)::int n from public.mfa_trusted_devices where token_hash = $1`, [TOKEN])).rows[0].n).toBe(0);
    expect((await db.query<{ d: number }>(`select extract(day from expires_at - created_at)::int d from public.mfa_trusted_devices`)).rows[0].d).toBe(30);
  });
});
