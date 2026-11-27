// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Shulim, 2026-11-23: fund.trubase.org is the platform address. The organization comes from the address
// (org_domains, e.g. oizer.trubase.org), from ?org=, or after sign-in from the login; the default organization only
// on pages.dev, never for other addresses that match none.
const rpc = vi.fn();
vi.mock('./supabase', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) }, setRequestOrg: vi.fn() }));
vi.mock('./format', () => ({ setTimezone: vi.fn() }));

const OIZER = { id: 'o1', slug: 'oizer', name: 'Oizer', logo_url: null, primary_color: null, timezone: 'America/New_York' };
const at = (href: string) => { Object.defineProperty(window, 'location', { value: new URL(href), configurable: true, writable: true }); };

describe('the platform address and organization addresses', () => {
  beforeEach(() => { vi.resetModules(); rpc.mockReset(); vi.stubEnv('VITE_DEFAULT_ORG', 'oizer'); vi.stubEnv('DEV', false); });
  afterEach(() => vi.unstubAllEnvs());

  it('uses the default organization only on pages.dev (and the dev server)', async () => {
    const { defaultOrgSlug } = await import('./org');
    expect(defaultOrgSlug('oizer-drm.pages.dev')).toBe('oizer');
    expect(defaultOrgSlug('abc123.oizer-drm.pages.dev')).toBe('oizer');
    expect(defaultOrgSlug('fund.trubase.org')).toBeNull();
    expect(defaultOrgSlug('oizer.trubase.org')).toBeNull();
    expect(defaultOrgSlug('other.trubase.org')).toBeNull();
  });

  it('finds no organization on fund.trubase.org before sign-in, and never asks for Oizer there', async () => {
    at('https://fund.trubase.org/');
    rpc.mockResolvedValue({ data: [], error: null });
    const { resolveOrg } = await import('./org');
    expect(await resolveOrg()).toBeNull();
    expect(rpc).toHaveBeenCalledWith('resolve_org', { p_host: 'fund.trubase.org', p_slug: null });
  });

  it('finds an organization subdomain by its hostname alone (no default slug sent that could win over it)', async () => {
    at('https://oizer.trubase.org/');
    rpc.mockResolvedValue({ data: [OIZER], error: null });
    const { resolveOrg, orgLink } = await import('./org');
    expect(await resolveOrg()).toEqual(OIZER);
    expect(rpc).toHaveBeenCalledWith('resolve_org', { p_host: 'oizer.trubase.org', p_slug: null });
    // On the organization's own address, links need nothing added.
    expect(orgLink('give/1001', OIZER)).toBe('https://oizer.trubase.org/give/1001');
  });

  it('uses ?org= on the platform address, and links made there carry it', async () => {
    at('https://fund.trubase.org/?org=oizer');
    rpc.mockResolvedValue({ data: [OIZER], error: null });
    const { resolveOrg, orgLink, applyOrg } = await import('./org');
    expect(await resolveOrg()).toEqual(OIZER);
    expect(rpc).toHaveBeenCalledWith('resolve_org', { p_host: 'fund.trubase.org', p_slug: 'oizer' });
    expect(orgLink('give/1001', OIZER)).toBe('https://fund.trubase.org/give/1001?org=oizer');
    // After sign-in, the organization the app shows is the default for links.
    applyOrg(OIZER);
    expect(orgLink('give/1001')).toBe('https://fund.trubase.org/give/1001?org=oizer');
  });

  it('builds payment links, page links and widget snippets with orgLink, and team links keep ?org=', () => {
    expect(readFileSync('src/pages/Outreach.tsx', 'utf8')).toContain('orgLink(`give/${encodeURIComponent(c.id)}`)');
    expect(readFileSync('src/pages/Outreach.tsx', 'utf8')).toContain('data-campaign="${campaign.id}"${orgAttr}');
    expect(readFileSync('src/pages/Templates.tsx', 'utf8')).toContain('orgLink(`give/${encodeURIComponent(campaignId)}`)');
    expect(readFileSync('src/pages/Give.tsx', 'utf8')).toContain('/give/${encodeURIComponent(tm.id)}${window.location.search}');
  });

  it('lets payment pages on fund.trubase.org and organization subdomains through the give gate, and watches fund', () => {
    expect(readFileSync('workers/give-gate/wrangler.toml', 'utf8')).toMatch(/ALLOWED_ORIGINS = "fund\.trubase\.org,\*\.trubase\.org,/);
    expect(readFileSync('workers/uptime/wrangler.toml', 'utf8')).toContain('APP_URLS = "https://fund.trubase.org/,https://oizer.trubase.org/');
  });
});
