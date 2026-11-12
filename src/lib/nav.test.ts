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
    expect(seen.length).toBeGreaterThan(20);   // a sanity check that the menu was read (25 pages after Exchange and Last 7 Days went)
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

describe('Payouts tabs (Moshe Henig, 2026-11-11)', () => {
  it('are Payouts, Check Register (admins only) and Requests, in that order, and Check Register is no longer its own entry', () => {
    expect(navBlock).toContain("tabs: [{ to: '/expenses', label: 'Payouts' }, { to: '/checks', label: 'Check Register', admin: true }, { to: '/payout-requests', label: 'Requests' }] },");
    expect(navBlock).not.toContain("{ to: '/checks', label: 'Check Register', icon:");
    expect(app).toContain('<Route path="checks" element={<AdminOnly><ChecksPage /></AdminOnly>} />');
  });
});

describe('page switches (Moshe Henig, 2026-11-11)', () => {
  it('never shrink to an empty bar inside a column layout', () => {
    expect(readFileSync(join(__dirname, '..', 'styles.css'), 'utf8')).toContain('.tabs { flex-shrink: 0; }');
  });
});

describe('your own settings (Moshe Henig, 2026-11-11)', () => {
  it('are in Settings in the menu, not buttons beside Log out', () => {
    expect(navBlock).toContain("{ to: '/notifications', label: 'My Notifications', icon: <Bell size={I} /> },");
    expect(navBlock).toContain("{ to: '/security', label: 'Account Security', icon: <Lock size={I} /> },");
    const foot = layout.slice(layout.indexOf('<div className="sidebar-foot">'), layout.indexOf('</nav>'));
    expect(foot).not.toContain('to="/notifications"');
    expect(foot).not.toContain('to="/security"');
  });
});

describe('Transactions group (Moshe Henig, 2026-11-11)', () => {
  it('holds Transactions first, then Payouts, Transfers and Bank Reconciliation; there is no Donations group', () => {
    const group = navBlock.slice(navBlock.indexOf("title: 'Transactions'"), navBlock.indexOf("title: 'Settings'"));
    const shown = [...group.matchAll(/\{ to: '([^']+)', label: '([^']+)', icon:[^\n]*/g)].filter(m => !m[0].includes('offMenu: true')).map(m => m[2]);
    expect(shown).toEqual(['Transactions', 'Payouts', 'Transfers', 'Bank Reconciliation']);
    expect(navBlock).not.toContain("title: 'Donations'");
    expect(navBlock).not.toContain("title: 'Payouts'");
  });
});

describe('Campaigns menu (Moshe Henig, 2026-11-11)', () => {
  it('combines Campaigns and People in this order: Campaigns, Fundraisers, Donors, Payees, Machine Bookings', () => {
    const group = navBlock.slice(navBlock.indexOf("title: 'Campaigns & People'"), navBlock.indexOf("title: 'Transactions'"));
    expect([...group.matchAll(/\{ to: '([^']+)', label: '([^']+)', icon:/g)].map(m => m[2])).toEqual(['Campaigns', 'Fundraisers', 'Donors', 'Payees', 'Machine Bookings']);
    expect(navBlock).not.toContain("title: 'People'");
  });
});
