import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dayOffset, inRange, rangeBounds, rangeLabel, RANGE_PRESETS } from './dateRange';

// Moshe Henig, 2026-11-11: the Last 7 Days tab becomes a date range on the Transactions list, with presets and a
// custom range, saved per person through "Save as my default".
// Days are counted in the organization's time zone (New York, the default), whatever zone this computer is in
// (Moshe Henig, 2026-11-15). Midnight in New York is 04:00 UTC in daylight time (to Nov 1 2026) and 05:00 UTC after.
const now = new Date('2026-11-11T20:30:00Z');   // Nov 11 2026, 3:30 pm in New York
const day = (y: number, m: number, d: number) => {
  const ymd = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const daylight = ymd >= '2026-03-08' && ymd <= '2026-11-01';
  return new Date(Date.UTC(y, m - 1, d, daylight ? 4 : 5)).toISOString();
};

describe('date range', () => {
  it('offers the presets Moshe asked for', () => {
    expect(RANGE_PRESETS.map(p => p.label)).toEqual(['All time', 'Today', 'Last 7 days', 'Last 30 days', 'Last 60 days', 'Last year', 'Custom range…']);
  });

  it('counts whole days back from today, today included', () => {
    // Today (Moshe Henig, 2026-11-15): from the start of today to the start of tomorrow.
    expect(rangeBounds({ preset: 'today' }, now)).toEqual({ from: day(2026, 11, 11), to: day(2026, 11, 12) });
    expect(rangeLabel({ preset: 'today' })).toBe('Today');
    expect(rangeBounds({ preset: '7' }, now)).toEqual({ from: day(2026, 11, 5) });
    expect(rangeBounds({ preset: '30' }, now)).toEqual({ from: day(2026, 10, 13) });
    expect(rangeBounds({ preset: '60' }, now)).toEqual({ from: day(2026, 9, 13) });
    expect(rangeBounds({ preset: '365' }, now)).toEqual({ from: day(2025, 11, 12) });
    expect(rangeBounds({ preset: 'all' }, now)).toEqual({});
    expect(rangeBounds(undefined, now)).toEqual({});
  });

  it('includes both ends of a custom range', () => {
    expect(rangeBounds({ preset: 'custom', from: '2026-10-01', to: '2026-10-31' }, now)).toEqual({ from: day(2026, 10, 1), to: day(2026, 11, 1) });
    expect(rangeBounds({ preset: 'custom', from: '2026-10-01' }, now)).toEqual({ from: day(2026, 10, 1) });
    const b = rangeBounds({ preset: 'custom', from: '2026-10-01', to: '2026-10-31' }, now);
    expect(inRange('2026-11-01T03:59:00Z', b)).toBe(true);    // Oct 31, 11:59 pm in New York
    expect(inRange('2026-11-01T04:01:00Z', b)).toBe(false);   // Nov 1, 12:01 am in New York
    expect(inRange('2026-10-01T03:59:00Z', b)).toBe(false);   // Sep 30, 11:59 pm in New York
    expect(inRange(null, b)).toBe(false);
    expect(inRange(null, {})).toBe(true);
    expect(rangeLabel({ preset: '30' })).toBe('Last 30 days');
    expect(dayOffset(-29, now)).toBe('2026-10-13');
  });

  it('replaces the Last 7 Days tab with one Transactions list, and old links still land there', () => {
    const layout = readFileSync('src/components/Layout.tsx', 'utf8');
    expect(layout).not.toContain("label: 'Last 7 Days'");
    expect(layout).toContain("{ to: '/donations/all', label: 'Transactions', icon: <CircleDollarSign size={I} />,");
    expect(readFileSync('src/App.tsx', 'utf8')).toContain('<Route path="donations/recent" element={<Navigate to="/donations/all" replace />} />');
    expect(readFileSync('src/pages/Donations.tsx', 'utf8')).not.toContain('function RecentDonations');
  });

  it('filters the rows, totals and select-all by the range, starting on Last 7 days, and is saved with the view', () => {
    const src = readFileSync('src/pages/Donations.tsx', 'utf8');
    expect(src).toContain("dateRange={{ column: 'created_at', defaultPreset: filter ? 'all' : '7' }}");
    expect(src).toMatch(/const conditions = \(base: any\) => \{[^]*const anyDate = !!text \|\| cardIds !== null;[^]*if \(!anyDate && query\?\.range\.from\) s = s\.gte\('created_at', query\.range\.from\);[^]*if \(!anyDate && query\?\.range\.to\) s = s\.lt\('created_at', query\.range\.to\);/);
    const table = readFileSync('src/components/DataTable.tsx', 'utf8');
    expect(table).toContain('const setRange = (r: DateRange) => setConfig({ ...config, range: r });');
    expect(table).toContain("<select aria-label=\"Date\" value={range.preset}");
    expect(readFileSync('src/components/TableCustomize.tsx', 'utf8')).toMatch(/export interface TableConfig \{[^]*range\?: DateRange;/);
  });
});

describe('date range in the organization\'s time zone (Moshe Henig, 2026-11-15)', () => {
  it('starts Today at midnight New York time, not midnight on this computer', () => {
    // 11:30 pm in New York is already the next day in UTC; it is still Nov 11 in New York.
    const late = new Date('2026-11-12T04:30:00Z');
    expect(rangeBounds({ preset: 'today' }, late)).toEqual({ from: '2026-11-11T05:00:00.000Z', to: '2026-11-12T05:00:00.000Z' });
    expect(dayOffset(0, late)).toBe('2026-11-11');
  });
});
