import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, OIZER, as, rows, seededDb } from './harness';

// Two-step verification for bank data (Shulim, 2026-11-11). A password-only session (aal1) can use the rest of
// Donor Base but can't see or change bank and reconciliation data; after a TOTP code (aal2) it can.
const asLevel = <T = Record<string, any>>(db: PGlite, aal: 'aal1' | 'aal2', q: string, params: unknown[] = []) =>
  as(db, ADMIN, async tx => (await tx.query<T>(q, params)).rows, undefined, aal);

describe('two-step verification for bank data', () => {
  let base: PGlite;
  let db: PGlite;
  beforeAll(async () => {
    base = await seededDb();
    await base.query(`update public.org_members set role = 'super_admin' where user_id = $1`, [ADMIN]);
    await base.query(`insert into public.accounts (org_id, id, name) values ($1, 'a1', 'Operating') on conflict do nothing`, [OIZER]);
    await base.query(`insert into public.bank_lines (org_id, account_id, posted_date, amount, description, fingerprint, source)
                      values ($1, 'a1', '2026-11-02', 180, 'Deposit', 'mfa-test-1', 'import')`, [OIZER]);
  });
  beforeEach(async () => { db = await base.clone(); });

  it('hides bank lines and reconciliation from a password-only session, even a Super Admin’s', async () => {
    expect(await asLevel(db, 'aal1', `select count(*)::int as n from public.bank_lines`)).toEqual([{ n: 0 }]);
    for (const q of [
      `select * from public.bank_reconciliation_summary()`,
      `select * from public.bank_book_items('a1')`,
      `select public.add_bank_line('a1', '2026-11-03', 25, 'Typed', null)`,
      `select public.plaid_admin_check('a1')`,
    ]) {
      await expect(asLevel(db, 'aal1', q)).rejects.toThrow(/Two-step verification is needed/);
    }
    expect(await asLevel(db, 'aal1', `select * from public.plaid_status()`)).toEqual([]);
  });

  it('shows them once the session has passed two-step verification', async () => {
    expect(await asLevel(db, 'aal2', `select count(*)::int as n from public.bank_lines`)).toEqual([{ n: 1 }]);
    expect((await asLevel(db, 'aal2', `select * from public.bank_reconciliation_summary()`)).length).toBeGreaterThan(0);
    expect((await asLevel(db, 'aal2', `select public.plaid_admin_check('a1') as org`))[0].org).toBe(OIZER);
  });

  it('leaves everything else working without it, so nobody is locked out', async () => {
    expect((await asLevel(db, 'aal1', `select public.my_access() as a`))[0].a.role).toBe('super_admin');
    expect((await asLevel(db, 'aal1', `select count(*)::int as n from public.donations`))[0].n).toBeGreaterThan(0);
    expect((await asLevel(db, 'aal1', `select count(*)::int as n from public.campaigns`))[0].n).toBeGreaterThan(0);
  });

  it('defaults to "not verified" when the session says nothing', async () => {
    expect((await rows(db, 'service_role', `select public.mfa_ok() as ok`))[0].ok).toBe(false);
  });
});
