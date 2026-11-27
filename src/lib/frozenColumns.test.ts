import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Moshe Henig, 2026-11-17: scrolled columns showed through between the frozen Donor and Amount columns.
describe('frozen list columns', () => {
  const table = readFileSync('src/components/DataTable.tsx', 'utf8');
  const css = readFileSync('src/styles.css', 'utf8');
  it('measure exact widths and measure again when a column resizes', () => {
    expect(table).toContain('getBoundingClientRect().width');
    expect(table).toContain('new ResizeObserver(measure)');
    expect(table).not.toContain('cells[0].offsetWidth');   // the old whole-pixel measurement
  });
  it('paint each row state solidly, cover the seam, match the header, and end in a divider', () => {
    expect(css).toContain('--cell-bg: var(--surface); background: var(--cell-bg); box-shadow: 1px 0 0 var(--cell-bg);');
    expect(css).toContain('.grid tbody tr:nth-child(even) td.frozen { --cell-bg: var(--row-alt); }');   // the zebra (Trubase UI)
    expect(css).toContain('.grid tr.clickable:hover td.frozen { --cell-bg: var(--surface-2); }');
    expect(css).toContain('.grid thead th.frozen { z-index: 3; --cell-bg: var(--table-head); }');
    expect(css).toContain('.grid th.frozen-last, .grid td.frozen-last');
  });
});
