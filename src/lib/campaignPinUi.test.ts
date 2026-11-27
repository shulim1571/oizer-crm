import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Campaign PINs (Moshe Henig, approved by Shulim, 2026-11-10): set in campaign settings, never shown, removable,
// and every try reviewable on the Phone & Text Lookup page.
describe('campaign PIN screens', () => {
  it('sets a 4-digit PIN from campaign settings and never shows one', () => {
    expect(readFileSync('src/lib/schemas.ts', 'utf8')).toMatch(/name: 'pin', label: 'Phone PIN', help: '4 digits\./);
    expect(readFileSync('src/pages/Campaigns.tsx', 'utf8')).not.toMatch(/key: 'pin'/);
  });
  it('can remove it from the campaign’s More menu', () => {
    const src = readFileSync('src/pages/CampaignDetail.tsx', 'utf8');
    expect(src).toContain("label: 'Remove phone PIN'");
    expect(src).toContain("supabase.rpc('set_campaign_pin', { p_campaign: id, p_pin: null })");
  });
  it('lists every PIN try with what was locked', () => {
    const src = readFileSync('src/pages/PhoneLookup.tsx', 'utf8');
    expect(src).toContain('<th>PIN tried</th>');
    expect(src).toContain("r.lock_kind === 'campaign'");
  });
});
