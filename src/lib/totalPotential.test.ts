import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Moshe Henig, 2026-11-13: Total potential = raised + open pledges + pending + checks not delivered, each counted once.
describe('campaign Total potential', () => {
  const src = readFileSync('src/pages/CampaignDetail.tsx', 'utf8');
  it('adds pending and undelivered checks to raised and open pledges', () => {
    expect(src).toContain("Number(c.combined_raised ?? c.raised ?? 0) + Number(c.combined_pledged_open ?? c.pledged_open ?? 0)");
    expect(src).toContain("Number(c.combined_pending ?? c.pending_balance ?? 0) + Number(c.combined_undelivered_checks ?? c.undelivered_checks_amount ?? 0)");
    expect(src).toContain('value={money(totalPotential(c))}');
  });
  it('counts teams on the parent (Moshe #11)', () => {
    expect(readFileSync('supabase/migrations/20261222008000_total_potential_teams.sql', 'utf8')).toContain('AS combined_pledged_open');
  });
  it('relies on raised already leaving out undelivered checks', () => {
    const view = readFileSync('supabase/migrations/20261222003200_undelivered_checks.sql', 'utf8');
    expect(view).toMatch(/WHEN donations\.delivered = false AND donations\.payment_method ~~\* '%check%'::text THEN 0::numeric\s+WHEN donations\.type = 'Payment'/);
  });
});
