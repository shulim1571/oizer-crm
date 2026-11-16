import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, MANAGER_1, MANAGER_2, OIZER, as, rows, seededDb } from './harness';

// Readiness #46 (2026-11-15): a readable history per donation, payout and transfer; a fundraiser-safe version.
const hist = (db: PGlite, user: string, table: string, id: string) =>
  rows<{ who: string; action: string; changes: Record<string, any> }>(db, user, `select who, action, changes from public.record_history($1, $2)`, [table, id], OIZER);

describe('record history', () => {
  let base: PGlite;
  let db: PGlite;
  beforeAll(async () => { base = await seededDb(); });
  beforeEach(async () => { db = await base.clone(); });

  it("shows an edit to a donation as field, old and new, with who made it", async () => {
    await as(db, ADMIN, tx => tx.query(`update public.donations set notes = 'Corrected' where id = 'p1'`), OIZER);
    const h = await hist(db, ADMIN, 'donations', 'p1');
    const edit = h.find(x => x.action === 'update' && x.changes.notes);
    expect(edit).toBeTruthy();
    expect(edit!.who).toBe('office@example.org');
    expect(edit!.changes.notes).toEqual({ old: null, new: 'Corrected' });
  });

  it("lets a fundraiser see their own campaign's history, without bank details, and the office as 'The office'", async () => {
    await as(db, ADMIN, tx => tx.query(`update public.donations set notes = 'Corrected', bank_reference = 'BR-9' where id = 'p1'`), OIZER);
    const h = await hist(db, MANAGER_1, 'donations', 'p1');   // 1001 is MANAGER_1's campaign
    const edit = h.find(x => x.action === 'update' && x.changes.notes);
    expect(edit!.who).toBe('The office');
    expect(edit!.changes.bank_reference).toBeUndefined();
    expect(edit!.changes.notes).toEqual({ old: null, new: 'Corrected' });
    // Not their campaign: nothing.
    expect(await hist(db, MANAGER_2, 'donations', 'p1')).toEqual([]);
  });

  it('covers payouts and transfers, and nothing else', async () => {
    await as(db, ADMIN, tx => tx.query(`update public.expenses set description = 'Rent' where id = 'e1'`), OIZER);
    expect((await hist(db, ADMIN, 'expenses', 'e1')).some(x => x.changes.description)).toBe(true);
    await as(db, ADMIN, tx => tx.query(`update public.transfers set description = 'Moved' where id = 't1'`), OIZER);
    expect((await hist(db, ADMIN, 'transfers', 't1')).some(x => x.changes.description)).toBe(true);
    await expect(hist(db, ADMIN, 'donors', 'd1')).rejects.toThrow(/No history/);
  });
});
