import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import OrgContact from './OrgContact';

const render = (email: string | null, phone: string | null) => renderToStaticMarkup(createElement(OrgContact, { email, phone }));

// Moshe Henig, 2026-11-10: the campaign banner shows the organization's email and phone from its settings.
describe('organization contact on the campaign banner', () => {
  it('shows both when set, as links', () => {
    const html = render("office@example.org", "(845) 555-0100");
    expect(html).toContain('href="mailto:office@example.org"');
    expect(html).toContain('href="tel:8455550100"');
    expect(html).toContain('(845) 555-0100');
  });
  it('hides each one that isn’t set, and the whole line when neither is', () => {
    expect(render("office@example.org", "  ")).not.toContain('tel:');
    expect(render(null, "845-555-0100")).not.toContain('mailto:');
    expect(render("", null)).toBe('');
  });
  it('comes from the organization settings, not hardcoded values', async () => {
    const { readFileSync } = await import('node:fs');
    expect(readFileSync('src/pages/CampaignDetail.tsx', 'utf8')).toContain('<OrgContact email={org?.email} phone={org?.phone} />');
  });
});
