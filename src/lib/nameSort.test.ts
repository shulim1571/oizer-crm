import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { lastFirst } from './nameSort';

// Moshe Henig, 2026-11-12: donor and fundraiser lists sort by last name, then first name, A-Z and Z-A. Sample names.
const people = [
  { first_name: 'Zev', last_name: 'Cohen', display_name: 'Zev Cohen' },
  { first_name: 'Aaron', last_name: 'Levi', display_name: 'Aaron Levi' },
  { first_name: 'Abe', last_name: 'Cohen', display_name: 'Abe Cohen' },
  { first_name: '', last_name: '', display_name: 'Sample Foundation' },
  { first_name: 'Moshe', last_name: 'Adler', display_name: 'Moshe Adler' },
];
// The same comparison the list makes for parts.
const compare = (a: string[], b: string[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const c = (a[i] ?? '').localeCompare(b[i] ?? '', undefined, { sensitivity: 'base' });
    if (c) return c;
  }
  return 0;
};

describe('name sorting', () => {
  it('orders by last name, then first name', () => {
    const az = [...people].sort((x, y) => compare(lastFirst(x, 'display_name'), lastFirst(y, 'display_name'))).map(p => p.display_name);
    expect(az).toEqual(['Moshe Adler', 'Abe Cohen', 'Zev Cohen', 'Aaron Levi', 'Sample Foundation']);
    const za = [...people].sort((x, y) => -compare(lastFirst(x, 'display_name'), lastFirst(y, 'display_name'))).map(p => p.display_name);
    expect(za).toEqual(['Sample Foundation', 'Aaron Levi', 'Zev Cohen', 'Abe Cohen', 'Moshe Adler']);
  });
  it('is used by the donor list and the fundraiser list, and by the list sort', () => {
    expect(readFileSync('src/pages/Donors.tsx', 'utf8')).toContain("sortValue: r => lastFirst(r, 'display_name'),");
    expect(readFileSync('src/pages/SimplePages.tsx', 'utf8')).toContain("sortValue: (r: Record<string, unknown>) => lastFirst(r, 'full_name')");
    expect(readFileSync('src/components/DataTable.tsx', 'utf8')).toContain('const xs = col.sortValue(a), ys = col.sortValue(b);');
  });
});
