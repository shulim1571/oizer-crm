import { describe, expect, it } from 'vitest';
import { pieSlices } from './MethodPie';

// Moshe Henig, 2026-11-11: a pie of donations by payment method beside Donations over time.
describe('payment method pie', () => {
  it('gives each method its share, largest first, in fixed color order', () => {
    const { sum, slices } = pieSlices([{ name: 'Cash', total: 100 }, { name: 'Credit Card', total: 300 }]);
    expect(sum).toBe(400);
    expect(slices.map(s => [s.name, s.share, s.color])).toEqual([['Credit Card', 0.75, 'var(--series-1)'], ['Cash', 0.25, 'var(--series-2)']]);
  });
  it('folds anything past five methods into Other', () => {
    const rows = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((name, i) => ({ name, total: 70 - i * 10 }));
    const { slices } = pieSlices(rows);
    expect(slices.map(s => s.name)).toEqual(['A', 'B', 'C', 'D', 'E', 'Other (2)']);
    expect(slices[5]).toMatchObject({ total: 30, color: 'var(--series-other)' });
  });
  it('leaves out methods with nothing', () => {
    expect(pieSlices([{ name: 'Zelle', total: 0 }]).slices).toEqual([]);
  });
});
