import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { pageItems } from './Pager';

// Moshe Henig, 2026-11-10: numbered pages, to jump several pages at once, keeping Previous and Next; and the
// transaction lists open on successful (completed) transactions only.
describe('numbered pages', () => {
  it('shows the first and last page, two either side of the current one, and … for the gaps', () => {
    expect(pageItems(6, 42)).toEqual([1, '…', 4, 5, 6, 7, 8, '…', 42]);
    expect(pageItems(1, 42)).toEqual([1, 2, 3, '…', 42]);
    expect(pageItems(42, 42)).toEqual([1, '…', 40, 41, 42]);
    expect(pageItems(4, 42)).toEqual([1, 2, 3, 4, 5, 6, '…', 42]);   // a one-page gap shows the page
    expect(pageItems(3, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageItems(1, 1)).toEqual([1]);
    expect(pageItems(1, 0)).toEqual([1]);
  });

  it('is used by the transaction list and every client-paged table, with Previous and Next', () => {
    const pager = readFileSync('src/components/Pager.tsx', 'utf8');
    expect(pager).toMatch(/Previous[^]*pageItems[^]*Next/);
    expect(readFileSync('src/pages/Donations.tsx', 'utf8')).toContain('<Pager page={page} pages={pages} onPage={setPage} />');
    expect(readFileSync('src/components/DataTable.tsx', 'utf8')).toContain('<Pager page={currentPage} pages={pages} onPage={setPage} />');
  });

  it('opens the transaction lists on successful transactions, still changeable', () => {
    const src = readFileSync('src/pages/Donations.tsx', 'utf8');
    expect(src).toContain("export const DEFAULT_KIND = 'Successful';");
    expect(src).toContain('useState(DEFAULT_KIND)');
    expect(src.match(/<option value="">All types<\/option>/g)?.length).toBe(1);   // one list now (the Last 7 Days tab became a date range)
    expect(readFileSync('src/pages/donationColumns.tsx', 'utf8')).toContain("Successful: { status: 'completed' }");
  });
});
