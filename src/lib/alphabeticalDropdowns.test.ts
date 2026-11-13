import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { byLabel } from './byLabel';

// Moshe Henig, 2026-11-11: campaign, donor and similar dropdowns are always alphabetical by name, never by ID.
describe('dropdown order', () => {
  it('is alphabetical by name, ignoring case, with numbers in natural order', () => {
    const list = ['Oizer second - 1002', 'chaim Medical - 1012', 'Bnei Torah - 1001', 'Table 10 - 1003A', 'Table 2 - 1003B'].map(label => ({ label }));
    expect([...list].sort(byLabel).map(o => o.label)).toEqual(['Bnei Torah - 1001', 'chaim Medical - 1012', 'Oizer second - 1002', 'Table 2 - 1003B', 'Table 10 - 1003A']);
  });

  it('shows campaigns by name first, sorts every shared lookup list, and every searchable dropdown', () => {
    const lookups = readFileSync('src/lib/lookups.ts', 'utf8');
    expect(lookups).toContain('label: `${c.internal_name || c.campaign_name || c.external_name || c.id} - ${c.id}');
    expect(lookups).toContain('load().then(list => [...list].sort(byLabel))');
    const select = readFileSync('src/components/SearchSelect.tsx', 'utf8');
    expect(select).toContain('const options = useMemo(() => (keepOrder ? given : [...given].sort(byLabel)), [given, keepOrder]);');
  });
});
