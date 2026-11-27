import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, OIZER, rows, seededDb } from './harness';

// Moshe Henig, 2026-11-16: "why does it take so long for the dashboard to fill in the numbers?" dashboard_stats
// built every campaign's full balance just to add up three pledge figures; they're now summed from the pledges.
// They must stay exactly what the campaigns add up to.
const q = <T = Record<string, any>>(db: PGlite, sql: string, params: unknown[] = []) => rows<T>(db, ADMIN, sql, params, OIZER);
const ins = async (db: PGlite, table: string, v: Record<string, unknown>) => {
  const k = Object.keys(v);
  return (await q<{ id: string }>(db, `insert into public.${table} (${k.join(',')}) values (${k.map((_, i) => `$${i + 1}`).join(',')}) returning id`, Object.values(v)))[0].id;
};

describe('dashboard pledge figures', () => {
  let base: PGlite;
  let db: PGlite;
  beforeAll(async () => { base = await seededDb(); });
  beforeEach(async () => { db = await base.clone(); });

  it('equal what the campaigns add up to: open pledges, and what is due in 30 and 90 days', async () => {
    const today = (await q<{ d: string }>(db, `select public.org_today()::text d`))[0].d;
    const plus = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);
    // A schedule: due in 10, 40 and 70 days, one installment partly paid.
    const rec = await ins(db, 'pledges', { campaign_id: '1001', donor_id: 'd1', is_recurring: true, installment_amount: 300, frequency: 'monthly', start_date: plus(10), installment_count: 3 });
    await q(db, `select public.pay_pledge($1, 100, 'Cash')`, [rec]);
    await ins(db, 'pledges', { campaign_id: '1002', donor_id: 'd2', amount: 750 });
    const gone = await ins(db, 'pledges', { campaign_id: '1003', donor_id: 'd2', amount: 400 });
    await q(db, `select public.cancel_pledge($1, 'test')`, [gone]);
    const [{ s }] = await q(db, `select public.dashboard_stats(public.org_today() - 29, public.org_today()) s`);
    const [c] = await q(db, `select sum(pledged_open) p, sum(pledge_scheduled_30) s30, sum(pledge_scheduled_90) s90 from public.campaign_summary`);
    expect(Number(s.pledged)).toBe(Number(c.p));
    expect(Number(s.scheduled_30)).toBe(Number(c.s30));
    expect(Number(s.scheduled_90)).toBe(Number(c.s90));
    expect(Number(s.pledged)).toBeGreaterThan(0);
    expect(Number(s.scheduled_90)).toBeGreaterThan(Number(s.scheduled_30));
  });

  it('no longer builds every campaign balance for them', async () => {
    const [{ src }] = (await db.query<{ src: string }>(`select prosrc src from pg_proc where proname = 'dashboard_stats'`)).rows;
    expect(src).not.toMatch(/from public\.campaign_summary/);
  });
});
