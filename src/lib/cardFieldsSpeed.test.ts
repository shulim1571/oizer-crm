import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Card screen speed (Shulim, 2026-11-22): connect to Sola early, start its script with the page data, one organization
// lookup, and no sign-in checks on the public payment page.
describe('card fields load sooner', () => {
  it('opens the connection to Sola in the payment page HTML', () => {
    expect(readFileSync('functions/give/[id].ts', 'utf8')).toContain('<link rel="preconnect" href="https://cdn.cardknox.com" />');
  });
  it('downloads Sola\'s script alongside the page data, and keeps one version in one place', () => {
    const lib = readFileSync('src/lib/ifields.ts', 'utf8');
    expect(lib).toContain("add({ rel: 'preload', as: 'script', href: `${IFIELDS}/ifields.min.js` });");
    expect(readFileSync('src/main.tsx', 'utf8')).toContain('if (giveCampaignId) warmIfields();');
    expect(readFileSync('src/pages/Payments.tsx', 'utf8')).not.toContain("const IFIELDS_VERSION =");
  });
  it('shows the payment page without the sign-in machinery, and asks for the organization once', () => {
    const main = readFileSync('src/main.tsx', 'utf8');
    expect(main).toContain('? <GivePage campaignId={giveCampaignId} />');
    expect(main).toContain(': <AuthProvider><App /></AuthProvider>}');
    expect(readFileSync('src/lib/org.ts', 'utf8')).toContain('if (orgLookup?.key === key) return orgLookup.answer;');
  });
});
