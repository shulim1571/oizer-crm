import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Moshe Henig, 2026-11-11: list filters move from the row under the headings to a panel on the right of every
// list, closed until the Filter button is tapped. The Type dropdown stays in the toolbar.
const table = readFileSync('src/components/DataTable.tsx', 'utf8');
const css = readFileSync('src/styles.css', 'utf8');

describe('filter panel', () => {
  it('replaces the filter row in the shared list, so every list has it', () => {
    expect(table).not.toContain('filter-row');
    expect(table).toContain('<aside className="filter-panel" id="list-filter-panel" aria-label="Filters">');
    expect(css).toMatch(/\.table-area\.with-filters \{ grid-template-columns: minmax\(0, 1fr\) 270px; \}/);   // on the right
  });

  it('is closed by default and opens and closes with the Filter button', () => {
    expect(table).toContain('const [showFilters, setShowFilters] = useState(false);');
    expect(table).toMatch(/onClick=\{\(\) => setShowFilters\(s => !s\)\}[^>]*\n?\s*aria-expanded=\{showFilters\} aria-controls="list-filter-panel"/);
    expect(table).toContain('aria-label="Close filters" onClick={() => setShowFilters(false)}');
  });

  it('keeps each column’s filter as it was: same columns, same hints, same matching', () => {
    const panel = table.slice(table.indexOf('<aside className="filter-panel"'), table.indexOf('</aside>'));
    expect(panel).toContain('columns.filter(c => !server || c.filter)');
    expect(panel).toContain("placeholder={c.filter?.type === 'number' || c.align === 'right' ? '>100' : c.filter?.type === 'date' ? 'YYYY-MM-DD' : 'Contains…'}");
    expect(panel).toContain('onChange={e => setFilter(c.key, e.target.value)}');
    expect(panel).toContain('setConfig({ ...config, filters: {} })');   // Clear all
  });

  it('leaves the Type dropdown in the toolbar, outside the panel', () => {
    const panel = table.slice(table.indexOf('<aside className="filter-panel"'), table.indexOf('</aside>'));
    expect(panel).not.toMatch(/aria-label="Type"|All types/);
    expect(readFileSync('src/pages/Donations.tsx', 'utf8').match(/actions=\{[^]*?<select value=\{(kindFilter|kind)\}/g)?.length).toBe(2);
  });

  it('slides over the list on narrow screens', () => {
    expect(css).toMatch(/@media \(max-width: 900px\) \{[^]*\.filter-panel \{ position: fixed; top: 0; right: 0;/);
  });
});
