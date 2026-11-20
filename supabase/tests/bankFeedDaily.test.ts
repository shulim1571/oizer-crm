import { describe, expect, it } from 'vitest';
import { ADMIN, OIZER, as, seededDb } from './harness';

// Readiness #60 (2026-11-15): bank lines unmatched over 7 days reach the Task Sheet; a bank fee is one click.
describe('bank feed', () => {
  it('lists bank lines unmatched for more than 7 days in the books check', async () => {
    const db = await seededDb();
    const n = async () => Number((await db.query<{ n: number }>(`select n from public.integrity_checks($1) where check_key = 'stale_bank_lines'`, [OIZER])).rows[0].n);
    const before = await n();
    await db.query(`insert into public.bank_lines (org_id, id, account_id, posted_date, amount, description, source, fingerprint)
                    values ($1, 'st-1', 'a1', public.org_today() - 10, -15, 'Service charge', 'import', 'st-1'),
                           ($1, 'st-2', 'a1', public.org_today() - 2, 40, 'Deposit', 'import', 'st-2')`, [OIZER]);
    expect(await n()).toBe(before + 1);   // only the 10-day-old one
  });

  it('records a bank fee in one step, matched for the organization', async () => {
    const db = await seededDb();
    await db.query(`insert into public.bank_lines (org_id, id, account_id, posted_date, amount, description, source, fingerprint)
                    values ($1, 'bf-1', 'a1', public.org_today() - 1, -12.5, 'Monthly fee', 'import', 'bf-1')`, [OIZER]);
    await as(db, ADMIN, tx => tx.query(`select public.match_bank('a1', array['bf-1'], '[]', 'bank_fee', 'Bank fee')`), OIZER);
    const [m] = (await db.query<{ difference_type: string; difference: string }>(
      `select m.difference_type, m.difference from public.recon_matches m join public.bank_lines l on l.match_id = m.id where l.id = 'bf-1'`)).rows;
    expect(m).toEqual({ difference_type: 'bank_fee', difference: '-12.50' });
  });

  it('can list linked accounts only for the scheduled sync', async () => {
    const db = await seededDb();
    await expect(as(db, ADMIN, tx => tx.query(`select * from public.plaid_linked_accounts()`), OIZER)).rejects.toThrow(/permission denied/);
  });
});
