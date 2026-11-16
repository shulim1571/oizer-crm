import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, OIZER, rows, seededDb } from './harness';

// Readiness #19 (2026-11-15): "Available to pay out", display only: the balance less card gifts the processor
// hasn't paid out yet (the card hold) and recent checks the bank hasn't cleared.
const avail = async (db: PGlite) => {
  const [r] = await rows<Record<string, string>>(db, ADMIN, `select * from public.campaign_available('1003')`, [], OIZER);
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v)]));
};
const put = (db: PGlite, id: string, method: string, amount: number, daysAgo = 0, extra = '') =>
  db.query(`insert into public.donations (org_id, id, campaign_id, type, status, amount, manual_fee, payment_method, created_at${extra ? ', delivered' : ''})
            values ($1, $2, '1003', 'Payment', 'completed', $3, 0, $4, now() - make_interval(days => $5)${extra ? `, ${extra}` : ''})`, [OIZER, id, amount, method, daysAgo]);

describe('available to pay out', () => {
  let base: PGlite;
  let db: PGlite;
  beforeAll(async () => {
    base = await seededDb();
    await base.query(`update public.payment_methods set category = 'Gateway' where org_id = $1 and name = 'Credit Card'`, [OIZER]);
  });
  beforeEach(async () => { db = await base.clone(); });

  it('holds back recent card gifts and recent checks not cleared yet, and nothing older', async () => {
    const before = await avail(db);
    await put(db, 'av-card', 'Credit Card', 200);         // today: inside the 3-day card hold
    await put(db, 'av-card-old', 'Credit Card', 50, 10);  // paid out by now
    await put(db, 'av-chk', 'Check', 300, 2);             // recent, not matched to the bank
    await put(db, 'av-chk-old', 'Check', 40, 45);          // older than 30 days: not counted as waiting
    const a = await avail(db);
    expect(a.balance - before.balance).toBe(590);
    expect(a.card_hold - before.card_hold).toBe(200);
    expect(a.checks_uncleared - before.checks_uncleared).toBe(300);
    expect(a.available).toBeCloseTo(a.balance - a.card_hold - a.checks_uncleared, 2);
    expect(a.hold_days).toBe(3);
  });

  it("follows the organization's card hold setting", async () => {
    await put(db, 'av-card2', 'Credit Card', 200, 1);
    expect((await avail(db)).card_hold).toBeGreaterThanOrEqual(200);
    await db.query(`update public.organizations set payout_hold_days = 0 where id = $1`, [OIZER]);
    const a = await avail(db);
    expect(a.card_hold).toBe(0);
    expect(a.hold_days).toBe(0);
  });

  it('counts a check as cleared once it is matched to a bank line', async () => {
    await put(db, 'av-chk2', 'Check', 300, 1);
    const held = (await avail(db)).checks_uncleared;
    await db.query(`insert into public.recon_matches (org_id, id, account_id, kind, lines_total, items_total, difference) values ($1, 'm-av', 'a1', 'manual', 300, 300, 0)`, [OIZER]);
    await db.query(`insert into public.recon_match_items (org_id, match_id, item_type, item_id, amount) values ($1, 'm-av', 'donation', 'av-chk2', 300)`, [OIZER]);
    expect((await avail(db)).checks_uncleared).toBeCloseTo(held - 300, 2);
  });
});
