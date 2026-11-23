import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Shulim, 2026-11-12: the product's name and logo are in the product chrome. Renamed from Donor Base to FundBase
// (Shulim, 2026-11-22), with the FundBase kit in data/brand-fundbase.
describe('FundBase branding', () => {
  it('names the product FundBase in the browser tab and has its icons', () => {
    const html = readFileSync('index.html', 'utf8');
    expect(html).toContain('<title>FundBase</title>');
    expect(html).toContain('href="/brand/favicon-32.png"');
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');
    for (const f of ['public/brand/fundbase-icon.svg', 'public/brand/fundbase-icon-dark.svg', 'public/brand/fundbase-logo.svg', 'public/brand/fundbase-logo-dark.svg',
      'public/brand/fundbase-logo-endorsed-dark.svg', 'public/brand/app-icon-192.png', 'public/brand/app-icon-512.png', 'public/favicon.ico', 'public/apple-touch-icon.png']) expect(existsSync(f), f).toBe(true);
  });

  it('has no "Campaign CRM" product label left', () => {
    for (const f of ['src/components/Layout.tsx', 'src/pages/Login.tsx', 'index.html']) expect(readFileSync(f, 'utf8')).not.toContain('Campaign CRM');
  });

  it('heads the menu with the FundBase logo, the organization’s logo and name under it', () => {
    const layout = readFileSync('src/components/Layout.tsx', 'utf8');
    expect(layout).toContain('<div className="brand-row"><ProductLockup /></div>');
    expect(layout).toContain('? <img className="logo org-logo" src={sharpLogoUrl(org.logo_url)!}');
    expect(readFileSync('src/App.tsx', 'utf8')).toContain('<div className="splash"><ProductMark /></div>');
    expect(readFileSync('src/lib/org.ts', 'utf8')).toContain('document.title = `${org.name} · FundBase`;');
  });

  it('lets organization admins upload a logo file', () => {
    const page = readFileSync('src/pages/Organization.tsx', 'utf8');
    expect(page).toContain('<input type="file" accept="image/png,image/jpeg,image/webp"');
    expect(page).toContain("supabase.from('organizations').update({ logo_url: dataUrl }).eq('id', org.id)");
  });

  // Shulim, 2026-11-22: the FundBase brand kit (data/brand-fundbase), refreshed to the Crown mark; nothing from alternates/.
  it('applies the brand kit: teal accent, Inter text (Jost only in the logo images), Crown icons, light sign-in with the endorsed logo', () => {
    // The kit folder isn't in git, so this check runs only where it's present.
    if (existsSync('data/brand-fundbase/fundbase-icon.svg')) {
      for (const f of ['fundbase-icon.svg', 'fundbase-icon-dark.svg', 'fundbase-logo.svg', 'fundbase-logo-dark.svg', 'fundbase-logo-endorsed-dark.svg']) {
        expect(readFileSync(`public/brand/${f}`, 'utf8'), f).toBe(readFileSync(`data/brand-fundbase/${f}`, 'utf8'));
      }
      expect(readFileSync('public/brand/fundbase-icon.svg', 'utf8')).not.toBe(readFileSync('data/brand-fundbase/alternates/fundbase-icon-offering.svg', 'utf8'));
    }
    const tokens = readFileSync('src/fundbase-tokens.css', 'utf8');
    expect(tokens).toContain('--fb-accent-500: #0E8A74;');
    expect(tokens).toContain('--fb-accent-600: #0C7461;');
    expect(tokens).toContain('--fb-accent-dark: #41C8B0;');
    expect(tokens).toContain('--fb-bg-dark: #0F1116;');
    expect(tokens).toContain('--fb-font-display: "Jost"');
    expect(readFileSync('src/main.tsx', 'utf8')).toContain("import './fundbase-tokens.css';");
    const css = readFileSync('src/styles.css', 'utf8');
    expect(css).toContain('--accent: var(--fb-accent-500);');
    expect(css).toContain('--accent-text: var(--fb-accent-600);');
    expect(css).toMatch(/--accent: var\(--fb-accent-dark\);[\s\S]*--on-accent: var\(--fb-bg-dark\);/);
    expect(css).not.toContain('--db-');
    expect(css).not.toMatch(/#4f46e5|#7c3aed|#4338ca/i);
    const html = readFileSync('index.html', 'utf8');
    // Moshe, 2026-11-23: the app's text stays in Inter as before FundBase; Jost only in the logo wordmark (drawn into the SVGs).
    expect(html).not.toContain('Jost');
    expect(readFileSync('public/privacy.html', 'utf8')).not.toContain('Jost');
    expect(css).not.toMatch(/font-family:[^;]*(Jost|--font-display|--fb-font-display)/);
    expect(css).toContain('h1 { font-size: 22px; font-weight: 650; letter-spacing: -.02em; margin: 0; }');
    expect(css).toContain('h2 { font-size: 16px; font-weight: 600; letter-spacing: -.01em; margin: 24px 0 10px; }');
    expect(readFileSync('public/brand/fundbase-logo.svg', 'utf8')).not.toMatch(/<text|font-family/);   // wordmark is drawn, needs no font
    expect(html).toContain('<meta name="theme-color" content="#0E8A74"');
    for (const f of ['index.html', 'public/site.webmanifest', 'src/components/Layout.tsx', 'src/lib/org.ts', 'src/pages/Login.tsx', 'src/pages/Organization.tsx']) {
      expect(readFileSync(f, 'utf8').replace(/renamed from Donor Base/g, ''), f).not.toMatch(/Donor Base|donor-base/);
    }
    const manifest = JSON.parse(readFileSync('public/site.webmanifest', 'utf8'));
    expect(manifest.icons.map((i: { src: string }) => i.src)).toEqual(['/brand/app-icon-192.png', '/brand/app-icon-512.png']);
    expect(readFileSync('src/pages/Login.tsx', 'utf8')).toContain('<ProductLockup endorsed light />');   // light, not black (Moshe, 2026-11-23)
    expect(css).toMatch(/\.auth \{\n {2}--bg: var\(--fb-bg-subtle\);[^}]*color-scheme: light;/);
    expect(existsSync('public/brand/fundbase-logo-endorsed.svg')).toBe(true);
    for (const f of ['src/components/Layout.tsx', 'src/pages/Login.tsx', 'index.html', 'public/site.webmanifest']) expect(readFileSync(f, 'utf8')).not.toMatch(/offering|heart|alternates/i);
  });

  // Shulim, 2026-11-23: Plaid's bank-connection screen names the app FundBase.
  it('names the app FundBase on Plaid\'s bank-connection screen', () => {
    const plaid = readFileSync('supabase/functions/plaid/index.ts', 'utf8');
    expect(plaid).toContain("client_name: 'FundBase',");
    expect(plaid).not.toContain("client_name: 'Oizer'");
  });
});
