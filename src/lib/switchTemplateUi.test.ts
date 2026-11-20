import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Moshe Henig, 2026-11-10: change an existing campaign to a different template.
describe('Change template', () => {
  it('is in the campaign’s More menu for admins and calls the switch', () => {
    const detail = readFileSync('src/pages/CampaignDetail.tsx', 'utf8');
    expect(detail).toContain("{ label: 'Change template', onClick: () => setSwitchingTemplate(true), hidden: !isAdmin }");
    expect(detail).toContain('<CampaignSettingsTab key={settingsKey} campaignId={id} />');
    const dialog = readFileSync('src/pages/Templates.tsx', 'utf8');
    expect(dialog).toContain("supabase.rpc('switch_campaign_template', { p_campaign: campaignId, p_template: pick })");
    expect(dialog).toMatch(/Everything else stays/);
  });
});
