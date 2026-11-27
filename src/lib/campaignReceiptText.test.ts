import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Moshe Henig, 2026-11-11: campaigns had their own receipt text removed. Shulim, 2026-11-22: brought back: the
// organization's receipt text is the default, and a campaign can override it (admins, in the campaign's settings).
describe('campaign receipt text', () => {
  it('is in the campaign settings, for admins', () => {
    expect(readFileSync('src/pages/Templates.tsx', 'utf8')).toContain('{isAdmin && <ReceiptTextCard level="campaign" refId={campaignId} title="Receipt text for this campaign" />}');
  });
  it('can be set for the organization, a fundraiser or a campaign, with the campaign winning', () => {
    expect(readFileSync('src/pages/Receipts.tsx', 'utf8')).toContain("level: 'default' | 'fundraiser' | 'campaign'; refId: string; title: string");
    const sql = readFileSync('supabase/migrations/20261222009600_receipt_text_campaigns.sql', 'utf8');
    expect(sql).toContain("check (level = any (array['default', 'fundraiser', 'campaign']))");
    expect(sql).toMatch(/select 1 as rank, r\.\* from public\.receipt_templates r join c on r\.org_id = c\.org_id and r\.level = 'campaign'/);
  });
});
