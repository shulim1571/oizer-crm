import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The sidebar is configuration in Layout.tsx; these checks keep it in step with the routes in App.tsx.
const layout = readFileSync(join(__dirname, '..', 'components', 'Layout.tsx'), 'utf8');
const app = readFileSync(join(__dirname, '..', 'App.tsx'), 'utf8');
const navBlock = layout.slice(layout.indexOf('const NAV:'), layout.indexOf('const OTHER:'));
const linked = [...navBlock.matchAll(/to: '([^']+)'/g)].map(m => m[1]);
const routes = new Set([...app.matchAll(/path="([^"]+)"/g)].map(m => `/${m[1]}`));

describe('sidebar', () => {
  it('links only to pages that exist', () => {
    expect(linked.filter(p => !routes.has(p))).toEqual([]);
  });

  it('lists each page once, as an entry or as one of its tabs', () => {
    // An entry's own `to` repeats its first tab; count every other appearance.
    const entries = [...navBlock.matchAll(/\{ to: '([^']+)', label: '[^']+', icon:[^\n]*?(tabs: \[[^\]]*\]|\n\s+tabs: \[[^\]]*\])?/g)];
    const seen: string[] = [];
    for (const e of entries) {
      const tabs = e[2] ? [...e[2].matchAll(/to: '([^']+)'/g)].map(m => m[1]) : [e[1]];
      if (e[2]) expect(tabs).toContain(e[1]);
      seen.push(...tabs);
    }
    expect(seen.length).toBeGreaterThan(25);
    expect(seen.filter((p, i) => seen.indexOf(p) !== i)).toEqual([]);
  });

  it('keeps Campaign Requests as a Campaigns tab, and sends the old address there', () => {
    expect(navBlock).toMatch(/\{ to: '\/campaigns\/requests', label: 'Requests' \}/);
    expect(linked).not.toContain('/requests');
    expect(app).toMatch(/path="requests" element=\{<Navigate to="\/campaigns\/requests" replace \/>\}/);
  });

  it('stays compact', () => {
    const entries = navBlock.match(/icon: </g) ?? [];
    expect(entries.length).toBeLessThanOrEqual(32);
  });
});
