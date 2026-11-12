import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MERGE_FIELDS } from './outreachFormat';

describe('Outreach fundraiser links (Moshe Henig, 2026-11-11)', () => {
  it('has a Fundraiser Links tab to set each fundraiser’s link, and {payment_link} to use it', () => {
    expect(readFileSync('src/components/Layout.tsx', 'utf8')).toContain("{ to: '/outreach/links', label: 'Fundraiser Links' }");
    expect(readFileSync('src/App.tsx', 'utf8')).toContain('<Route path="outreach/links" element={<AdminOnly><FundraiserLinksPage /></AdminOnly>} />');
    expect(readFileSync('src/pages/Outreach.tsx', 'utf8')).toContain("supabase.from('managers').update({ payment_link: link || null })");
    expect(MERGE_FIELDS).toContain('{payment_link}');
  });
});
