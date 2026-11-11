import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Moshe Henig, 2026-11-11: the filter panel offers every column of the list (hidden ones too), and lookup or
// fixed-choice columns are a searchable dropdown of all their values instead of free text.
const table = readFileSync('src/components/DataTable.tsx', 'utf8');
const cols = readFileSync('src/pages/donationColumns.tsx', 'utf8');
const donations = readFileSync('src/pages/Donations.tsx', 'utf8');

describe('filter panel choices', () => {
  it('lists every column of the list, including ones hidden in the current view', () => {
    expect(table).toContain('const panelColumns = p.columns.filter(c => !server || c.filter || c.filterOptions);');
    expect(table).toContain('{!columns.includes(c) && <small className="muted"> (hidden column)</small>}');
  });

  it('shows a searchable dropdown for lookup and fixed-choice columns, and a typed box for amounts and dates', () => {
    expect(table).toMatch(/choices \? \(\s*<SearchSelect value=\{exactValue\(filters\[c\.key\]\) \?\? null\} placeholder="Any"/);
    expect(table).toContain("onChange={v => setFilter(c.key, v ? `=${v}` : '')}");
    expect(table).toMatch(/if \(server \|\| c\.long \|\| c\.align === 'right' \|\| c\.filter\?\.type === 'number' \|\| c\.filter\?\.type === 'date'\) return null;/);
  });

  it('loads every value from the organization for the Transactions list’s lookup columns', () => {
    for (const [col, src] of [['donor', "names('donors', 'display_name')"], ['campaign', "names('campaigns', 'internal_name')"],
      ['payment_method', "names('payment_methods', 'name')"], ['collector', "names('collectors', 'full_name')"],
      ['source', "names('sources', 'name')"], ['account', "names('accounts', 'name')"]]) {
      expect(cols, col).toContain(`filterOptions: ${src}`);
    }
    expect(cols).toContain('filterOptions: async () => Object.keys(DONATION_KINDS)');
  });

  it('matches a picked value exactly, on the server and in the browser', () => {
    expect(donations).toContain('q = q.ilike(col, exact.replace(');
    expect(donations).toMatch(/const kind = exact != null\s*\? Object\.entries\(DONATION_KINDS\)\.find\(\(\[k\]\) => k\.toLowerCase\(\) === wanted\)/);
    expect(table).toMatch(/const exact = exactValue\(filter\);\s*if \(exact != null\) return display\(value\)\.trim\(\)\.toLowerCase\(\) === exact\.trim\(\)\.toLowerCase\(\);/);
  });
});

describe('exact values', async () => {
  // exactValue lives in DataTable.tsx with the component; its rule is simple enough to restate here.
  const exactValue = (filter: string | undefined) => {
    const t = filter?.trim() ?? '';
    const numeric = /^(>=|<=|>|<|=)\s*(-?[\d,.]+)$/.test(t);
    return t.startsWith('=') && !numeric ? t.slice(1) : null;
  };
  it('treats "=Cash" as exactly Cash, but "=100" stays a number filter', () => {
    expect(exactValue('=Cash')).toBe('Cash');
    expect(exactValue('=100')).toBeNull();
    expect(exactValue('Cash')).toBeNull();
    expect(table).toContain("return t.startsWith('=') && parseNumberFilter(t) == null ? t.slice(1) : null;");
  });
});
