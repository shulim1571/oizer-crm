import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Moshe Henig, 2026-11-11: on Transactions, search looks through all transactions whatever date range is set; the
// summary at the top is for all transactions; the totals for the current filter sit under the page buttons.
const src = readFileSync('src/pages/Donations.tsx', 'utf8');

describe('Transactions search and totals', () => {
  it('searches every date: the range is set aside while there is search text', () => {
    const cond = src.slice(src.indexOf('const conditions = (base: any) => {'), src.indexOf('return applyColumnFilters(s, columns'));
    expect(cond.indexOf("const text = debounced.trim()")).toBeLessThan(cond.indexOf("if (!text && query?.range.from)"));
    expect(cond).toContain("if (!text && query?.range.to) s = s.lt('created_at', query.range.to);");
    expect(src).toContain('Searching all dates: the date range is set aside while you search.');
  });

  it('works out the top summary from all transactions, not the range, type, filters or search', () => {
    const all = src.slice(src.indexOf('const allTotals = useQuery('), src.indexOf('const searching ='));
    expect(all).toContain("(filter ? q.eq(filter.column, filter.value) : q).in('status', ['completed', 'collect'])");
    expect(all).not.toMatch(/conditions\(|range|kindFilter|debounced/);
    expect(all).toContain("}, [filter?.column, filter?.value, version]);");
    expect(src).toMatch(/<div className="totals-bar">\s*<span className="muted small"><b>All transactions<\/b><\/span>\s*<span>Gross <b>\{money\(allTotals\.data\?\.gross/);
  });

  it('shows the totals for the current filter under the page buttons', () => {
    const foot = src.slice(src.indexOf('footer={'), src.indexOf('{editor}'));
    expect(foot.indexOf('<Pager page={page} pages={pages} onPage={setPage} />')).toBeLessThan(foot.indexOf('<div className="filter-totals"'));
    expect(foot).toContain('<span>Gross <b>{money(totals.data?.gross ?? 0)}</b></span>');
    expect(foot).toContain("transaction{data?.count === 1 ? '' : 's'}");
  });
});
