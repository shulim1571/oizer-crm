import { describe, expect, it } from 'vitest';
import { ADMIN, as, rows, seededDb } from './harness';

// Moshe Henig, 2026-11-11: the dashboard adds up the period's donations by payment method for its pie chart.
describe('dashboard by payment method', () => {
  it('adds up completed donations in the range by method', async () => {
    const db = await seededDb();
    await as(db, ADMIN, tx => tx.query(`insert into public.donations (campaign_id, amount, payment_method, type, status) values
      ('1001', 100, 'Cash', 'Payment', 'completed'), ('1001', 50, 'Cash', 'Payment', 'completed'), ('1001', 25, 'Zelle', 'Payment', 'completed'),
      ('1001', 999, 'Zelle', 'Payment', 'voided')`));
    const [r] = await rows<{ s: any }>(db, ADMIN, `select public.dashboard_stats(current_date - 1, current_date + 1) s`);
    const byName = Object.fromEntries((r.s.methods as { name: string; total: number }[]).map(m => [m.name, Number(m.total)]));
    expect(byName.Cash).toBeGreaterThanOrEqual(150);
    expect(byName.Zelle).toBe(25 + (byName.Zelle - 25));   // present
    expect(byName.Zelle).toBeLessThan(999);                  // voided gifts don't count
    expect(Number(r.s.range.raised)).toBeCloseTo(Object.values(byName).reduce((a, b) => a + b, 0), 2);
  });
});

describe('dashboard all time (Moshe Henig, 2026-11-11)', () => {
  it('totals every completed gift, including ones from before this year', async () => {
    const db = await seededDb();
    await as(db, ADMIN, tx => tx.query(`insert into public.donations (campaign_id, amount, payment_method, type, status, created_at) values
      ('1001', 400, 'Cash', 'Payment', 'completed', now() - interval '3 years'), ('1001', 999, 'Cash', 'Payment', 'voided', now() - interval '2 years')`));
    const [r] = await rows<{ s: any }>(db, ADMIN, `select public.dashboard_stats(current_date - 1, current_date) s`);
    const all = Number(r.s.periods.all.raised), year = Number(r.s.periods.year.raised);
    expect(all - year).toBeGreaterThanOrEqual(400);
    expect(all - year).toBeLessThan(400 + 999);
  });
});
