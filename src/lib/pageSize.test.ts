import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = (...p: string[]) => readFileSync(join(__dirname, '..', ...p), 'utf8');

// Moshe Henig, 2026-11-12: lists show 50 rows a page unless someone picked another size.
describe('default page size', () => {
  it('is 50, in one place, used by every list and by the rows-per-page picker', () => {
    const tc = src('components', 'TableCustomize.tsx');
    expect(tc).toContain('export const DEFAULT_PAGE_SIZE = 50;');
    expect(tc).toContain('value={config.pageSize ?? DEFAULT_PAGE_SIZE}');
    const dt = src('components', 'DataTable.tsx');
    expect(dt).toContain('const pageSize = config.pageSize ?? DEFAULT_PAGE_SIZE;');
    expect(dt).not.toMatch(/DEFAULT_PAGE_SIZE = 100/);
  });
});
