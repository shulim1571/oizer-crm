import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Readiness #55 (2026-11-15): campaign Settings tab: upload a banner and logo, one Save, quicker tab switching.
describe('campaign Settings tab', () => {
  const t = readFileSync('src/pages/Templates.tsx', 'utf8');
  it('takes an uploaded banner and logo as well as an address', () => {
    expect(t).toContain('<PictureField label="Banner" kind="photo"');
    expect(t).toContain('<PictureField label="Logo" kind="logo"');
    expect(t).toContain('onChange(await pictureToDataUrl(file,');
  });
  it('has one Save for the page and its settings', () => {
    expect(t).toContain("const b = a.error ? a : await supabase.rpc('save_campaign_settings', { p_campaign: campaignId, p_settings: settings });");
    expect(t).not.toContain('Save page</button>');
    expect(t).not.toContain('Save settings</button>');
  });
  it('shows a tab\'s rows at once when switching back', () => {
    const c = readFileSync('src/pages/CampaignDetail.tsx', 'utf8');
    expect(c).toContain('const shownRows = rows.loading ? tabRows.current.get(tab) ?? null : (rows.data as Row[] | null);');
    expect(c).toContain('loading={rows.loading && !shownRows}');
  });
});
