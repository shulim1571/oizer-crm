import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// FundBase on the shared Trubase UI design system (Shulim, 2026-11-27; /workspace/trubase-logo/ui-system). These guard
// the system's rules so later changes don't drift from them.
const css = readFileSync('src/styles.css', 'utf8');
const tsx = (dir: string): string[] => readdirSync(dir).flatMap(f => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? tsx(p) : /\.tsx$/.test(f) && !/\.test\.tsx$/.test(f) ? [p] : [];
});

describe('Trubase UI design system', () => {
  it('uses the system tokens with Fund teal, and Inter (Jost only in the logo images)', () => {
    expect(readFileSync('index.html', 'utf8')).toContain('<html lang="en" data-app="fundbase">');
    expect(readFileSync('index.html', 'utf8')).toContain('family=Inter:wght@400;500;600&');
    expect(readFileSync('src/main.tsx', 'utf8')).toContain("import './trubase-tokens.css';");
    expect(css).toContain('--font-ui: "Inter", "Noto Sans Hebrew", Helvetica, Arial, sans-serif;');
    expect(css).not.toMatch(/font(-family)?:[^;]*Jost/);
  });

  it('keeps to weights 400/500/600, the type scale, and the radius set', () => {
    for (const m of css.matchAll(/font-weight:\s*([^;}\s]+)/g)) expect(['400', '500', '600', 'inherit', 'normal', 'var(--fw-regular)', 'var(--fw-medium)', 'var(--fw-semibold)'], m[0]).toContain(m[1].replace('!important', ''));
    for (const m of css.matchAll(/font-size:\s*([\d.]+)px/g)) expect([11, 12, 14, 16, 24, 28], m[0]).toContain(Number(m[1]));
    for (const m of css.matchAll(/border-radius:\s*(\d+)px/g)) expect([4, 8, 12, 16, 999], m[0]).toContain(Number(m[1]));
  });

  it('has no gradients, glass or glows in the UI', () => {
    expect(css).not.toMatch(/(linear|radial)-gradient\(/);
    expect(css).not.toMatch(/backdrop-filter/);
    expect(readFileSync('src/pages/Give.tsx', 'utf8')).not.toMatch(/linear-gradient\(180deg/);   // the photo gets a flat tint
  });

  it('writes borders with a width, never the color token as one', () => {
    expect(css).not.toContain('var(--line) solid');
  });

  it('draws Lucide outline icons at a 1.5 stroke, 16 or 20 px only', () => {
    expect(css).toContain('svg.lucide { stroke-width: 1.5; fill: none; }');
    expect(css).not.toMatch(/fill: currentColor/);
    const sizes = tsx('src').flatMap(f => [...readFileSync(f, 'utf8').matchAll(/<[A-Z][A-Za-z0-9]* size=\{(\d+)\}/g)].map(m => `${f}:${m[1]}`));
    expect(sizes.filter(s => !/:(16|20)$/.test(s))).toEqual([]);
  });

  it('lays out the shell, KPI row and tables as the system does', () => {
    expect(css).toMatch(/\.kpis \{ display: grid; grid-auto-flow: column; grid-auto-columns: minmax\(0, 1fr\); gap: var\(--space-3\); \}/);
    expect(css).toContain('.grid tbody tr:nth-child(even) td { background: var(--row-alt); }');
    expect(css).toMatch(/\.grid th \{[^}]*height: var\(--thead-h\);[^}]*text-transform: uppercase;/);
    expect(css).toMatch(/\.grid td \{\n  height: var\(--row-h\);/);
    expect(css).toMatch(/\.sidebar a \{[^}]*height: var\(--nav-h\);/);
    expect(css).toMatch(/\.topbar \{[^}]*background: var\(--surface\);/);
    // One primary button per screen: the header's New Donation is secondary; each page keeps its own primary.
    expect(readFileSync('src/components/Layout.tsx', 'utf8')).toContain('className="btn small header-new-donation"');
  });
});
