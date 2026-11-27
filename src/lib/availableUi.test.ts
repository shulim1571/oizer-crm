import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Readiness #19 (2026-11-15): "Available to pay out" on the campaign page and the payout form, with why; display only.
describe('available to pay out in the app', () => {
  it('shows on the campaign page and in the payout form, with the explanation', () => {
    expect(readFileSync('src/pages/CampaignDetail.tsx', 'utf8')).toContain('<Kpi label="Available to pay out" value={<Balance value={avail.available} />}');
    const note = readFileSync('src/components/CampaignBalanceNote.tsx', 'utf8');
    expect(note).toContain("supabase.rpc('campaign_available', { p_campaign: campaignId })");
    expect(note).toContain('{avail && c.balance_mode !== \'shared\' && <AvailableLine a={avail} />}');
  });
  it('has the card hold setting on the Organization page', () => {
    expect(readFileSync('src/pages/Organization.tsx', 'utf8')).toContain("{ name: 'payout_hold_days', label: 'Card hold before payout (days)', type: 'number', required: true,");
  });
});
