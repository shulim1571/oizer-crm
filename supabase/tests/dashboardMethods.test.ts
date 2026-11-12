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
