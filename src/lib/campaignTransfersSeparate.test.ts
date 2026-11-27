import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Readiness #43 (2026-11-15): transfers were folded into Raised and Expenses on the campaign page. They're their own
// figures now, and Balance = gifts + transfers in - fees - payouts - transfers out (checked on all 386 campaigns).
describe('campaign page money boxes', () => {
  const c = readFileSync('src/pages/CampaignDetail.tsx', 'utf8');
  it('shows gifts and payouts apart from transfers in and out', () => {
    expect(c).toContain("supabase.rpc('campaign_transfer_totals')");
    expect(c).toContain("value={money(Number(c.combined_raised) - tIn)}");
    expect(c).toContain("value={money(Number(c.combined_expenses) - tOut)}");
    expect(c).toContain('<Kpi label="Transfers in" value={money(tIn)}');
    expect(c).toContain('<Kpi label="Transfers out" value={money(tOut)}');
  });
  it('spells out how the balance is made up, and marks each transfer In or Out on the campaign', () => {
    expect(c).toContain("`= gifts${tIn ? ' + transfers in' : ''} − fees − payouts${tOut ? ' − transfers out' : ''}`");
    expect(c).toContain("(r.to_campaign_id === id ? 'Transfer In' : 'Transfer Out')");
  });
});
