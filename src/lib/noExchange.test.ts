import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { campaignFields, newCampaignFields } from './schemas';

// Moshe Henig, 2026-11-11: the Exchange campaign feature is gone from the app. The campaigns.exchange column
// stays in the database until Shulim decides about it.
describe('no Exchange campaigns', () => {
  it('has no Exchange menu item, page, route or mode', () => {
    expect(readFileSync('src/components/Layout.tsx', 'utf8')).not.toMatch(/exchange/i);
    expect(readFileSync('src/App.tsx', 'utf8')).not.toMatch(/exchange/i);
    expect(readFileSync('src/pages/Campaigns.tsx', 'utf8')).not.toMatch(/exchange/i);
  });
  it('has no Exchange checkbox on the campaign forms', () => {
    expect(campaignFields.map(f => f.name)).not.toContain('exchange');
    expect(newCampaignFields.map(f => f.name)).not.toContain('exchange');
  });
});
