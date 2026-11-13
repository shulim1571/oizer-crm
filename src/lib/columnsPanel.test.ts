import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Moshe Henig, 2026-11-10: the Columns button "isn't working anywhere". The panel opened, but the general
// .popover rules (later in the file, same weight) beat the panel's own: it was pinned left, cut to 380px with
// overflow hidden, and its column list collapsed to nothing. The panel's rules now outrank them.
describe('Columns panel styles', () => {
  const css = readFileSync('src/styles.css', 'utf8');
  it('never styles the panel with a bare .customize rule that .popover can override', () => {
    expect(css).not.toMatch(/(^|\n)\.customize[\s{.:]/);
    expect(css).toMatch(/\.popover\.customize \{[^}]*right: 0; left: auto;[^}]*max-height: 70vh; overflow: auto;[^}]*display: grid/);
  });
  it('keeps the generic popover rules from reaching the panel', () => {
    expect(css).toMatch(/\.popover \{[^}]*left: 0;[^}]*overflow: hidden/);
    expect(css.indexOf('.popover.customize {')).toBeGreaterThan(-1);
  });
});
