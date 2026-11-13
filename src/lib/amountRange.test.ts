import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseNumberFilter, rangeEnds, rangeText } from './numberFilter';

// Moshe Henig, 2026-11-11: the Amount filter is a range, from amount to amount; either end can be left blank.
describe('amount range filter', () => {
  it('turns From and To into the filter, with either end blank', () => {
    expect(rangeText('100', '500')).toBe('100-500');
    expect(rangeText('100', '')).toBe('>=100');
    expect(rangeText('', '500')).toBe('<=500');
    expect(rangeText(' ', '')).toBe('');
    expect(parseNumberFilter(rangeText('100', '500'))).toEqual({ min: 100, max: 500 });
    expect(parseNumberFilter(rangeText('100', ''))).toEqual({ min: 100 });
    expect(parseNumberFilter(rangeText('', '500'))).toEqual({ max: 500 });
  });

  it('shows saved filters, old typed ones included, as From and To', () => {
    expect(rangeEnds('100-500')).toEqual({ from: '100', to: '500' });
    expect(rangeEnds('>=100')).toEqual({ from: '100', to: '' });
    expect(rangeEnds('<=500')).toEqual({ from: '', to: '500' });
    expect(rangeEnds('180')).toEqual({ from: '180', to: '180' });
    expect(rangeEnds(undefined)).toEqual({ from: '', to: '' });
  });

  it('is used for every number column in the filter panel', () => {
    const table = readFileSync('src/components/DataTable.tsx', 'utf8');
    expect(table).toContain("c.filter?.type === 'number' || (!server && c.align === 'right') ? (");
    expect(table).toContain('<RangeFilter label={c.label} value={filters[c.key]} onChange={text => setFilter(c.key, text)} />');
  });
});
