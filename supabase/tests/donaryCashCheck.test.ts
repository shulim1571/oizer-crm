import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, MANAGER_1, OIZER, freshDb, migrate, migrationFiles, rows, seed, seededDb } from './harness';

// Shulim, 2026-11-25: cash and check gifts from Donary (Make feed or webhook) arrive held. They aren't counted in
// totals, campaign progress, receipts or alerts until marked delivered. Sample data only.
const q = <T = Record<string, any>>(db: PGlite, sql: string, params: unknown[] = [], who = ADMIN) => rows<T>(db, who, sql, params, OIZER);
const give = async (db: PGlite, extra: Record<string, unknown>) => {
  const cols = { campaign_id: '1001', donor_id: 'd1', amount: 100, type: 'Payment', status: 'completed', ...extra };
  const keys = Object.keys(cols);
  return (await q<{ id: string; status: string }>(db, `insert into public.donations (${keys.join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')}) returning id, status`, Object.values(cols)))[0];
};
const summary = async (db: PGlite) => (await q<{ raised: string; donation_count: number; last_donation_at: string | null }>(db,
  `select raised, donation_count, last_donation_at from public.campaign_summary where id = '1001'`))[0];
const status = async (db: PGlite, id: string) => (await q<{ status: string; delivered: boolean | null }>(db, 'select status, delivered from public.donations where id = $1', [id]))[0];

describe('Donary cash and check gifts', () => {
  let base: PGlite;
  let db: PGlite;
  beforeAll(async () => {
    base = await seededDb();
    await base.query(`insert into public.messaging_settings (org_id, live) values ($1, true)`, [OIZER]);
    await base.query(`update public.notification_state set since = clock_timestamp()`);
  });
  beforeEach(async () => { db = await base.clone(); });

  it('arrive held, and count nowhere: raised, gift count, last gift, the transaction list', async () => {
    const before = await summary(db);
    const cash = await give(db, { payment_method: 'Cash', donary_id: 'DN-1', amount: 50 });
    const check = await give(db, { payment_method: 'Check', donary_id: 'DN-2', amount: 180, check_number: '1001' });
    expect([cash.status, check.status]).toEqual(['held', 'held']);
    const after = await summary(db);
    expect(Number(after.raised)).toBe(Number(before.raised));
    expect(after.donation_count).toBe(before.donation_count);
    expect(after.last_donation_at).toEqual(before.last_donation_at);
    expect((await q(db, `select counted, raised from public.transaction_list where id = $1`, [cash.id]))[0]).toEqual({ counted: false, raised: '0' });
  });

  it('leave card gifts from Donary and cash or checks entered in FundBase as they were', async () => {
    expect((await give(db, { payment_method: 'Credit Card', donary_id: 'DN-3' })).status).toBe('completed');
    expect((await give(db, { payment_method: 'Cash' })).status).toBe('completed');
    expect((await give(db, { payment_method: 'Check' })).status).toBe('completed');
    // A Donary check the card processor collected (it has the processor's reference) isn't held.
    expect((await give(db, { payment_method: 'Check', donary_id: 'DN-9', gateway_id: 'GW-1' })).status).toBe('completed');
  });

  it('get no receipt and no new-gift alert while held', async () => {
    const g = await give(db, { payment_method: 'Cash', donary_id: 'DN-4', amount: 75 });
    await expect(q(db, 'select public.issue_receipt($1)', [g.id])).rejects.toThrow(/completed/);
    await db.query(`select public.run_notifications()`);
    expect((await db.query(`select count(*)::int n from public.messages where kind = 'donation'`)).rows[0]).toEqual({ n: 0 });
  });

  it('stay held when Donary sends them again, and can still be voided', async () => {
    const g = await give(db, { payment_method: 'Check', donary_id: 'DN-5' });
    await db.query(`update public.donations set status = 'completed', notes = 'sent again' where id = $1`, [g.id]);
    expect((await status(db, g.id)).status).toBe('held');
    await db.query(`update public.donations set status = 'voided' where id = $1`, [g.id]);
    expect((await status(db, g.id)).status).toBe('voided');
  });

  it('count once marked delivered (admins only), from the list or by ticking Delivered on the gift', async () => {
    const before = Number((await summary(db)).raised);
    const a = await give(db, { payment_method: 'Cash', donary_id: 'DN-6', amount: 40 });
    const b = await give(db, { payment_method: 'Check', donary_id: 'DN-7', amount: 60 });
    await expect(q(db, 'select public.mark_donary_delivered($1)', [[a.id]], MANAGER_1)).rejects.toThrow();
    expect((await q<{ n: number }>(db, 'select public.mark_donary_delivered($1) n', [[a.id, 'not-a-held-gift']]))[0].n).toBe(1);
    expect(await status(db, a.id)).toEqual({ status: 'completed', delivered: true });
    // An admin ticking Delivered on the gift itself.
    await q(db, 'update public.donations set delivered = true where id = $1', [b.id]);
    expect(await status(db, b.id)).toEqual({ status: 'completed', delivered: true });
    expect(Number((await summary(db)).raised)).toBeCloseTo(before + 100, 2);
    // Staff can't make a held gift count by changing its status; that's what marking delivered is for.
    const c = await give(db, { payment_method: 'Cash', donary_id: 'DN-8' });
    await expect(q(db, `update public.donations set status = 'completed' where id = $1`, [c.id])).rejects.toThrow(/held donation can't be changed to completed/);
  });
});

describe('existing Donary cash and check gifts', () => {
  it('become held unless already marked delivered; card gifts, voided ones and office entries are untouched', async () => {
    // Every migration up to this one, some older Donary gifts, then this migration.
    const db = await freshDb();
    const files = migrationFiles();
    const mine = files.indexOf('20261222009900_donary_cash_check_held.sql');
    const split = files.indexOf('20261102000000_multi_tenant.sql');
    await migrate(db, files.slice(0, split));
    await seed(db);
    await migrate(db, files.slice(split, mine));
    await db.exec(`insert into public.donations (org_id, id, campaign_id, donor_id, type, status, amount, payment_method, donary_id, delivered) values
      ('${OIZER}', 'old-cash', '1001', 'd1', 'Payment', 'completed', 50, 'Cash', 'DN-OLD-1', null),
      ('${OIZER}', 'old-check', '1001', 'd1', 'Payment', 'completed', 180, 'Check', 'DN-OLD-2', null),
      ('${OIZER}', 'old-delivered', '1001', 'd1', 'Payment', 'completed', 36, 'Cash', 'DN-OLD-3', true),
      ('${OIZER}', 'old-card', '1001', 'd1', 'Payment', 'completed', 18, 'Credit Card', 'DN-OLD-4', null),
      ('${OIZER}', 'old-voided', '1001', 'd1', 'Payment', 'voided', 20, 'Cash', 'DN-OLD-5', null),
      ('${OIZER}', 'office-cash', '1001', 'd1', 'Payment', 'completed', 25, 'Cash', null, null)`);
    await migrate(db, [files[mine]]);
    const got = Object.fromEntries((await db.query<{ id: string; status: string }>(`select id, status from public.donations where id like 'old-%' or id = 'office-cash'`)).rows.map(r => [r.id, r.status]));
    expect(got).toEqual({ 'old-cash': 'held', 'old-check': 'held', 'old-delivered': 'completed', 'old-card': 'completed', 'old-voided': 'voided', 'office-cash': 'completed' });
  });
});
