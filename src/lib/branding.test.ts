import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Shulim, 2026-11-12: the product is Donor Base, with its logo in the product chrome; organizations show their own
// logo to their staff, falling back to the Donor Base logo.
describe('Donor Base branding', () => {
  it('names the product Donor Base in the browser tab and has its icons', () => {
    const html = readFileSync('index.html', 'utf8');
    expect(html).toContain('<title>Donor Base</title>');
    expect(html).toContain('href="/brand/favicon-32.png"');
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');
    for (const f of ['public/brand/donor-base-icon.svg', 'public/brand/donor-base-icon-dark.svg', 'public/brand/donor-base-logo.svg', 'public/brand/donor-base-logo-dark.svg',
      'public/brand/donor-base-logo-endorsed-dark.svg', 'public/brand/app-icon-192.png', 'public/brand/app-icon-512.png', 'public/favicon.ico', 'public/apple-touch-icon.png']) expect(existsSync(f), f).toBe(true);
  });

  it('has no "Campaign CRM" product label left', () => {
    for (const f of ['src/components/Layout.tsx', 'src/pages/Login.tsx', 'index.html']) expect(readFileSync(f, 'utf8')).not.toContain('Campaign CRM');
  });

  it('heads the menu with the Donor Base logo, the organization’s logo and name under it', () => {
    const layout = readFileSync('src/components/Layout.tsx', 'utf8');
    expect(layout).toContain('<div className="brand-row"><ProductLockup /></div>');
    expect(layout).toContain('? <img className="logo org-logo" src={sharpLogoUrl(org.logo_url)!}');
    expect(readFileSync('src/App.tsx', 'utf8')).toContain('<div className="splash"><ProductMark /></div>');
    expect(readFileSync('src/lib/org.ts', 'utf8')).toContain('document.title = `${org.name} · Donor Base`;');
  });

  it('lets organization admins upload a logo file', () => {
    const page = readFileSync('src/pages/Organization.tsx', 'utf8');
    expect(page).toContain('<input type="file" accept="image/png,image/jpeg,image/webp"');
    expect(page).toContain("supabase.from('organizations').update({ logo_url: dataUrl }).eq('id', org.id)");
  });

  // Shulim, 2026-11-22: the Donor Base brand kit (data/brand), Offering mark only, nothing from alternates/.
  it('applies the brand kit: teal accent, Jost and Inter, Offering icons, dark sign-in with the endorsed logo', () => {
    const css = readFileSync('src/styles.css', 'utf8');
    expect(css).toContain('--accent: #0E8A74;');
    expect(css).toContain('--accent-text: #0C7461;');
    expect(css).toMatch(/--accent: #41C8B0;[\s\S]*--on-accent: #0F1116;/);
    expect(css).toContain('--bg: #0F1116;');
    expect(css).toContain('--font-display: "Jost"');
    expect(css).not.toMatch(/#4f46e5|#7c3aed|#4338ca/i);
    const html = readFileSync('index.html', 'utf8');
    expect(html).toContain('family=Jost:');
    expect(html).toContain('<meta name="theme-color" content="#0E8A74"');
    const manifest = JSON.parse(readFileSync('public/site.webmanifest', 'utf8'));
    expect(manifest.icons.map((i: { src: string }) => i.src)).toEqual(['/brand/app-icon-192.png', '/brand/app-icon-512.png']);
    expect(readFileSync('src/pages/Login.tsx', 'utf8')).toContain('<ProductLockup endorsed dark />');
    for (const f of ['src/components/Layout.tsx', 'src/pages/Login.tsx', 'index.html', 'public/site.webmanifest']) expect(readFileSync(f, 'utf8')).not.toMatch(/crown|heart|alternates/i);
  });
});
