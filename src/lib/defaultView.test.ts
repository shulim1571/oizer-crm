import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Moshe Henig, 2026-11-11: every list can be saved as the person's own default (layout, column order, filters),
// and reset to the standard view.
const table = readFileSync('src/components/DataTable.tsx', 'utf8');
const views = readFileSync('src/components/TableCustomize.tsx', 'utf8');

describe('save this view as my default', () => {
  it('is in every list’s More menu, with Reset to standard view once a default exists', () => {
    expect(table).toMatch(/\{!p\.plain && <>[^]*?Save this view as my default<\/button>[^]*?\{saved\.hasDefault && <button[^]*?Reset to standard view<\/button>\}/);
    expect(table).toContain("setViewNote((await saved.saveAsDefault()) ?? 'Saved as your default view.')");
  });

  it('is also at the top of the Columns panel', () => {
    expect(views).toMatch(/<h3>My default<\/h3>[^]*Save as my default[^]*Reset to standard view[^]*<h3>Saved views<\/h3>/);
  });

  it('saves the whole current layout (columns, order, widths, sort, filters) as the default, per person', () => {
    expect(views).toContain("export const MY_DEFAULT = 'My default';");
    expect(views).toMatch(/saveAsDefault: async \(\) => \{[^]*update\(\{ config, is_default: true \}\)[^]*insert\(\{ table_key: tableKey, name: MY_DEFAULT, config, is_default: true \}\)/);
    const config = views.slice(views.indexOf('export interface TableConfig'), views.indexOf('export interface SavedViews'));
    for (const k of ['columns?:', 'widths?:', 'sort?:', 'filters?:', 'pageSize?:', 'freeze?:']) expect(config).toContain(k);
  });

  it('opens the saved default next time, before a server list asks for rows', () => {
    expect(views).toMatch(/const def = list\.find\(v => v\.is_default\);\s*if \(def\) \{\s*setConfig\(def\.config as TableConfig\);/);
    expect(table).toContain('if (onServerQuery && saved.ready) onServerQuery({ filters, sort, pageSize, range: bounds });');
  });

  it('resets to the standard view by turning the default off, keeping saved views', () => {
    expect(views).toMatch(/resetToStandard: async \(\) => \{[^]*update\(\{ is_default: false \}\)[^]*setConfig\(\{\}\);/);
  });
});
