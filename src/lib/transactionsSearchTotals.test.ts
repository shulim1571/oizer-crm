import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Moshe Henig, 2026-11-11: on Transactions, search looks through all transactions whatever date range is set; the
// summary at the top is for all transactions; the totals for the current filter sit under the page buttons.
const src = readFileSync('src/pages/Donations.tsx', 'utf8');

describe('Transactions search and totals', () => {
  it('searches every date: the range is set aside while there is search text', () => {
    const cond = src.slice(src.indexOf('const conditions = (base: any) => {'), src.indexOf('return applyColumnFilters(s, columns'));
    // Also while searching by the card's last 4 digits (Moshe Henig, 2026-11-12).
    expect(cond.indexOf("const text = debounced.trim()")).toBeLessThan(cond.indexOf("if (!anyDate && query?.range.from)"));
    expect(cond).toContain("const anyDate = !!text || cardIds !== null;");
    expect(cond).toContain("if (!anyDate && query?.range.to) s = s.lt('created_at', query.range.to);");
    expect(src).toContain('Searching all dates: the date range is set aside while you search.');
  });

  it('totals the current view at the top, with no second summary at the bottom (Moshe Henig, 2026-11-11)', () => {
    expect(src).toContain('<div className="totals-bar" aria-label="Totals for this view">');
    expect(src).toContain('<span>Gross <b>{money(totals.data?.gross ?? 0)}</b></span>');
    expect(src).not.toContain('allTotals');
    expect(src).not.toContain('filter-totals');
  });
});
