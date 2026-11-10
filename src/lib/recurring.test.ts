import { describe, expect, it } from 'vitest';
import { nextDate } from './recurring';

// Expected values are what Postgres gives for public.recurring_date(start, frequency, 1).
describe('next date in a recurring schedule', () => {
  it('matches the server', () => {
    expect(nextDate('2026-11-10', 'weekly')).toBe('2026-11-17');
    expect(nextDate('2026-12-29', 'weekly')).toBe('2027-01-05');
    expect(nextDate('2026-11-10', 'monthly')).toBe('2026-12-10');
    expect(nextDate('2027-01-31', 'monthly')).toBe('2027-02-28');
    expect(nextDate('2028-01-31', 'monthly')).toBe('2028-02-29');
    expect(nextDate('2026-11-30', 'quarterly')).toBe('2027-02-28');
    expect(nextDate('2026-12-15', 'monthly')).toBe('2027-01-15');
    expect(nextDate('2028-02-29', 'annually')).toBe('2029-02-28');
    expect(nextDate('2026-11-10', 'annually')).toBe('2027-11-10');
  });
});
