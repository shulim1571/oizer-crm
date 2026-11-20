import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KIND, kindOf, modeLabel } from './childCampaigns';

// Teams (shared balance) are separate from sub-campaigns (own balance) (Moshe Henig, 2026-11-11).
const src = (...p: string[]) => readFileSync(join(__dirname, '..', ...p), 'utf8');

describe('teams and sub-campaigns', () => {
  it('are named by their balance mode', () => {
    expect(kindOf('shared')).toBe('team');
    expect(kindOf('independent')).toBe('sub');
    expect(modeLabel('shared')).toBe('Team');
    expect(modeLabel('independent')).toBe('Sub-campaign');
    expect(KIND.team.mode).toBe('shared');
    expect(KIND.sub.mode).toBe('independent');
  });

  it('have their own tabs on a campaign, and the add form has no balance-mode choice', () => {
    const d = src('pages', 'CampaignDetail.tsx');
    expect(d).toContain("'pledges', 'vouchers', 'teams', 'sub-campaigns',");
    expect(d).toContain("kind={tab === 'teams' ? 'team' : 'sub'}");
    const s = src('pages', 'SubCampaigns.tsx');
    expect(s).toContain('p_mode: k.mode');
    expect(s).not.toContain('Balance mode *');
    expect(s).toContain("supabase.rpc('set_team_on_parent_page'");
  });

  it("list teams that are turned on on the parent's payment page, each linking to its own page", () => {
    const g = src('pages', 'Give.tsx');
    expect(g).toContain('teams.map((tm: Row) => (');
    expect(g).toContain('href={`/give/${encodeURIComponent(tm.id)}`}');
  });
});
