import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = (...p: string[]) => readFileSync(join(__dirname, '..', ...p), 'utf8');

describe('New Donation (Moshe Henig, 2026-11-11)', () => {
  it('goes to the Transactions list after recording, which says what was saved', () => {
    const d = src('pages', 'Donations.tsx');
    expect(d).toContain("onSaved={row => nav('/donations/all', { state: { notice:");
    expect(d).toContain('useState<string | null>(arrived)');
  });

  it('has a button in the header bar on every page, just before the bell, for admins', () => {
    const l = src('components', 'Layout.tsx');
    const header = l.slice(l.indexOf('<header className="topbar">'), l.indexOf('</header>'));
    const button = header.indexOf("nav('/donations/new')");
    expect(button).toBeGreaterThan(-1);
    expect(button).toBeLessThan(header.indexOf('className="icon-btn outlined bell"'));
    expect(header).toContain("{isAdmin && <button className=\"btn primary small header-new-donation\"");
  });
});

describe('sidebar (Moshe Henig, 2026-11-11)', () => {
  it('leaves New Donation off the menu, while its page keeps its tabs', () => {
    const l = src('components', 'Layout.tsx');
    expect(l).toContain("{ to: '/donations/new', label: 'New Donation', icon: <PlusCircle size={I} />, admin: true, offMenu: true,");
    expect(l).toContain('section.items.filter(n => visible(n) && !n.offMenu)');
    // Page tabs and breadcrumbs still come from every visible entry, including off-menu ones.
    expect(l).toContain('NAV.flatMap(s => s.items.filter(visible)');
  });
});
