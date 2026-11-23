import { setRequestOrg, supabase, type Row } from './supabase';
import { setTimezone } from './format';

export interface Org extends Row {
  id: string;
  slug: string;
  name: string;
  logo_url: string | null;
  primary_color: string | null;
  timezone: string;
}

const PLATFORM_ORG = 'platform-org';

/** The organization a Platform Owner has entered in this tab, if any. */
export const platformOrg = () => sessionStorage.getItem(PLATFORM_ORG);

export function enterPlatformOrg(id: string) {
  sessionStorage.setItem(PLATFORM_ORG, id);
  window.location.replace(window.location.pathname + window.location.search);
}

export function leavePlatformOrg() {
  sessionStorage.removeItem(PLATFORM_ORG);
  window.location.replace(window.location.pathname + window.location.search);
}

/**
 * The default organization (VITE_DEFAULT_ORG) applies only on pages.dev addresses and the dev server, never to other
 * addresses that match no organization (Shulim, 2026-11-23: fund.trubase.org is the platform address, where the
 * organization comes from the login, or ?org= for someone in several).
 */
export const defaultOrgSlug = (host = window.location.hostname): string | null =>
  (import.meta.env.DEV || host.endsWith('.pages.dev') ? import.meta.env.VITE_DEFAULT_ORG || null : null);

/** The organization this address itself belongs to (an org_domains hostname), once looked up. */
let hostOrgId: string | null = null;
/** The organization the app is showing (set by applyOrg: from the address, or from the login). */
let activeOrg: Org | null = null;

/**
 * The URL decides the organization: its hostname (org_domains), or ?org=slug; on pages.dev, the default one. On the
 * platform address (fund.trubase.org) there is none until sign-in. Asked once per page load: callers share the same
 * answer (the payment page and sign-in each asked, Shulim 2026-11-22).
 */
let orgLookup: { key: string; answer: Promise<Org | null> } | null = null;
export function resolveOrg(): Promise<Org | null> {
  const slug = new URLSearchParams(window.location.search).get('org') ?? defaultOrgSlug();
  const key = `${window.location.hostname}|${slug ?? ''}`;
  if (orgLookup?.key === key) return orgLookup.answer;
  const answer: Promise<Org | null> = (async () => {
    const { data, error } = await supabase.rpc('resolve_org', { p_host: window.location.hostname, p_slug: slug });
    // As before, a failed lookup reads as "no organization"; it isn't kept, so the next caller asks again.
    if (error) { if (orgLookup?.key === key) orgLookup = null; return null; }
    const org = ((data as Org[] | null) ?? [])[0] ?? null;
    hostOrgId = !slug && org ? org.id : null;   // found by the hostname alone
    return org;
  })();
  orgLookup = { key, answer };
  return answer;
}

/**
 * A public address on this site for an organization (a payment page, the donate widget's page): as is on the
 * organization's own hostname, with ?org=<slug> anywhere else (fund.trubase.org, pages.dev), so it opens the right
 * organization for someone who isn't signed in.
 */
export function orgLink(path: string, org: Pick<Org, 'id' | 'slug'> | null | undefined = activeOrg): string {
  const base = `${window.location.origin}${import.meta.env.BASE_URL}${path}`;
  return org?.slug && org.id !== hostOrgId ? `${base}${base.includes('?') ? '&' : '?'}org=${encodeURIComponent(org.slug)}` : base;
}

/** For tests: forget the last lookup. */
export const resetOrgLookup = () => { orgLookup = null; hostOrgId = null; activeOrg = null; };

/** Sends this organization with every data request and applies its branding. */
export function applyOrg(org: Org | null) {
  setRequestOrg(platformOrg() ?? org?.id ?? null);
  if (!org) return;
  activeOrg = org;
  setTimezone(org.timezone);
  document.title = `${org.name} · FundBase`;   // the product is FundBase (Shulim, renamed 2026-11-22)
  const root = document.documentElement.style;
  if (org.primary_color) {
    root.setProperty('--accent', org.primary_color);
    root.setProperty('--accent-2', org.primary_color);
  } else {
    root.removeProperty('--accent');
    root.removeProperty('--accent-2');
  }
}
