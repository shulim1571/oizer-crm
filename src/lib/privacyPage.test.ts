import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Shulim, 2026-11-23 (Google sign-in approval): a public privacy policy at /privacy, the Trubase policy adapted for
// FundBase by Trubase, linked from the sign-in page.
describe('privacy policy page', () => {
  const page = readFileSync('public/privacy.html', 'utf8');
  it('is a standalone public page (no app, no sign-in) for FundBase by Trubase', () => {
    expect(page).toContain('<title>Privacy Policy · FundBase</title>');
    expect(page).toContain('FundBase by Trubase ("FundBase") is a donation and campaign management service operated by Shulim Mueller DBA Trubase');
    expect(page).not.toMatch(/Donor Base/);
    expect(page).not.toMatch(/<script/i);
    for (const h of ['1. Information we handle', '2. How we use information', '3. How we share information', '4. Security', '5. Retention and deletion', '6. Your choices and rights', '7. Children', '8. Changes', '9. Contact']) expect(page).toContain(`<h2>${h}</h2>`);
  });
  it('says what Sign in with Google shares and that nothing else from Google is used', () => {
    expect(page).toContain('Google shares their name, email address, profile picture and Google account ID with FundBase');
    expect(page).toContain('We do not request access to Gmail, contacts, calendar, files or any other Google data');
  });
  it('is linked from the sign-in page and open to search engines and Google’s review', () => {
    expect(readFileSync('src/pages/Login.tsx', 'utf8')).toContain('<a href="/privacy">Privacy</a>');
    expect(readFileSync('public/robots.txt', 'utf8')).toMatch(/Allow: \/privacy\nDisallow: \//);
    expect(readFileSync('public/_headers', 'utf8')).toMatch(/\/privacy\n {2}! X-Robots-Tag/);
  });
});
