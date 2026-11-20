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
    for (const f of ['public/brand/donor-base-tile.png', 'public/brand/donor-base-mark.png', 'public/brand/donor-base-mark-white.png', 'public/favicon.ico', 'public/apple-touch-icon.png']) expect(existsSync(f), f).toBe(true);
  });

  it('has no "Campaign CRM" product label left', () => {
    for (const f of ['src/components/Layout.tsx', 'src/pages/Login.tsx', 'index.html']) expect(readFileSync(f, 'utf8')).not.toContain('Campaign CRM');
  });

  it('shows the organization’s logo when there is one, else the Donor Base logo', () => {
    const layout = readFileSync('src/components/Layout.tsx', 'utf8');
    expect(layout).toContain('? <img className="logo org-logo" src={sharpLogoUrl(org.logo_url)!}');
    expect(layout).toContain(': <ProductLogo onColor={onColor} />;');
    expect(readFileSync('src/App.tsx', 'utf8')).toContain('<img className="splash-mark" src={PRODUCT_MARK} alt="Donor Base" />');
    expect(readFileSync('src/lib/org.ts', 'utf8')).toContain('document.title = `${org.name} · Donor Base`;');
  });

  it('lets organization admins upload a logo file', () => {
    const page = readFileSync('src/pages/Organization.tsx', 'utf8');
    expect(page).toContain('<input type="file" accept="image/png,image/jpeg,image/webp"');
    expect(page).toContain("supabase.from('organizations').update({ logo_url: dataUrl }).eq('id', org.id)");
  });
});
