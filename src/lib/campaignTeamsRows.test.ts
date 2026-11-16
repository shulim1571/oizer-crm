import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Readiness #37 (2026-11-15): campaign 1008's header counted 6 donations (its team's included) while the tab listed
// its own 4, and its fee box ($2.13 with the team) didn't match the rows. The lists now include shared teams' rows,
// saying which campaign each is on, and every box that includes teams says so.
describe('a campaign with shared teams', () => {
  const c = readFileSync('src/pages/CampaignDetail.tsx', 'utf8');
  it('lists its teams\' gifts and payouts with its own, so the rows add up to the boxes', () => {
    expect(c).toContain(".eq('parent_campaign_id', id).eq('balance_mode', 'shared').is('deleted_at', null)");
    expect(c).toContain("supabase.from('donations').select(DONATION_SELECT).in('campaign_id', family)");
    expect(c).toContain("supabase.from('expenses').select('*, accounts(name)').in('campaign_id', family)");
    expect(c).toContain('columns: donationColumns({ hideCampaign: family.length < 2 }),');
  });
  it('labels the figures that include teams', () => {
    expect(c).toContain("label={withTeams ? 'Fees, with teams' : 'Fees'}");
    expect(c).toContain("label={withTeams ? 'Expenses, with teams' : 'Expenses'}");
    expect(c).toContain("donations${withTeams ? ' incl. teams' : ''}");
  });
});
