import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Moshe Henig, 2026-11-11: nothing below the dashboard's Donations over time box; the box itself unchanged.
describe('dashboard', () => {
  const d = readFileSync('src/pages/Dashboard.tsx', 'utf8');
  it('keeps the Donations over time box as it was', () => {
    expect(d).toContain('<h3>Donations over time</h3>');
    expect(d).toContain('<DailyChart daily={s?.daily ?? []} from={from} to={to} />');
  });
  it('has nothing below it on the admin dashboard', () => {
    const admin = d.slice(d.indexOf('export default function DashboardPage'));
    const after = admin.slice(admin.indexOf('<h3>Donations over time</h3>'), admin.indexOf('</section>'));
    for (const gone of ['Top campaigns', 'Most active fundraisers', 'By source', 'Latest donations', 'Overdue pledges by campaign', 'Near their goal']) expect(after).not.toContain(gone);
  });
});
