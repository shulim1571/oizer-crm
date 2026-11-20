// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { rangeDates } from './Dashboard';

// Readiness #9 (2026-11-15): Dashboard Today was $1,793 while Transactions showed $1,093. The dashboard picked its
// days from this computer's clock; Transactions (and the database) count days in New York time.
describe('dashboard date ranges', () => {
  const late = new Date('2026-11-12T04:30:00Z');   // 11:30 pm Wednesday Nov 11 in New York, already Nov 12 in UTC
  it('counts days in the organization time zone, whatever this computer says', () => {
    expect(rangeDates('today', '', '', late)).toEqual(['2026-11-11', '2026-11-11']);
    expect(rangeDates('yesterday', '', '', late)).toEqual(['2026-11-10', '2026-11-10']);
    expect(rangeDates('week', '', '', late)).toEqual(['2026-11-08', '2026-11-11']);
    expect(rangeDates('month', '', '', late)).toEqual(['2026-11-01', '2026-11-11']);
    expect(rangeDates('year', '', '', late)).toEqual(['2026-01-01', '2026-11-11']);
    expect(rangeDates('30', '', '', late)).toEqual(['2026-10-13', '2026-11-11']);   // the same 30 days as Transactions
  });

  it('writes down how each number is calculated, and puts checks not delivered with open pledges', () => {
    const src = readFileSync('src/pages/Dashboard.tsx', 'utf8');
    expect(src).toContain('How these numbers are calculated');
    expect(src).toContain('label="Pledged & checks not delivered"');
    expect(src).not.toContain('label="Pledged (open)"');
  });

  it('totals Transactions with the same raised rule', () => {
    const src = readFileSync('src/pages/Donations.tsx', 'utf8');
    expect(src).toContain("select('gross:raised.sum(),fees:fee.sum(),counted:id.count()')).eq('counted', true)");
    expect(src).toContain(".eq('undelivered_check', true)");
  });
});
