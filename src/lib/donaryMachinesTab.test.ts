import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Moshe Henig, 2026-11-15: Machine Bookings gets a Donary Machines tab (admins) to assign each machine's campaign.
describe('Donary Machines tab', () => {
  it('is the third tab of Machine Bookings, admins only, with its own route', () => {
    expect(readFileSync('src/components/Layout.tsx', 'utf8')).toContain("tabs: [{ to: '/calendar', label: 'Booking calendar' }, { to: '/machines', label: 'All bookings' }, { to: '/machines/donary', label: 'Donary Machines', admin: true }] },");
    const app = readFileSync('src/App.tsx', 'utf8');
    expect(app).toContain('<Route path="machines/donary" element={<AdminOnly><DonaryMachinesPage /></AdminOnly>} />');
    expect(app).toContain('<Route path="sources" element={<AdminOnly><SourcesPage /></AdminOnly>} />');   // Sources & machines stays
  });
  it('assigns with the same call as the machine window', () => {
    const m = readFileSync('src/pages/Machines.tsx', 'utf8');
    const page = m.slice(m.indexOf('export function DonaryMachinesPage'));
    expect(page).toContain("supabase.rpc('assign_machine', { p_machine: m.id, p_campaign: campaign, p_note: null })");
    expect(page).toContain("sources(name)");
  });
});
