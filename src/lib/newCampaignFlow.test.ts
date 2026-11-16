import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { newCampaignFields } from './schemas';

// Readiness #52 (2026-11-15): a new campaign showed only after a reload; it should ask for its Primary Fundraiser.
describe('a new campaign', () => {
  it('needs a Primary Fundraiser, who can be created from the box', () => {
    const f = newCampaignFields.find(x => x.name === 'manager_id')!;
    expect(f.required).toBe(true);
    expect(f.create).toBeTruthy();
  });
  it('shows in the list and every campaign box straight after saving', () => {
    const c = readFileSync('src/pages/Campaigns.tsx', 'utf8');
    expect(c).toContain('clearLookups();\n            void reload({ quiet: true });');
  });
});
