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
 * The URL decides the organization: its hostname, or ?org=slug. Dev builds can name a default slug. Asked once per page
 * load: callers share the same answer (the payment page and sign-in each asked, Shulim 2026-11-22).
 */
let orgLookup: { key: string; answer: Promise<Org | null> } | null = null;
export function resolveOrg(): Promise<Org | null> {
  const slug = new URLSearchParams(window.location.search).get('org') ?? import.meta.env.VITE_DEFAULT_ORG ?? null;
  const key = `${window.location.hostname}|${slug ?? ''}`;
  if (orgLookup?.key === key) return orgLookup.answer;
  const answer: Promise<Org | null> = (async () => {
    const { data, error } = await supabase.rpc('resolve_org', { p_host: window.location.hostname, p_slug: slug });
    // As before, a failed lookup reads as "no organization"; it isn't kept, so the next caller asks again.
    if (error) { if (orgLookup?.key === key) orgLookup = null; return null; }
    return ((data as Org[] | null) ?? [])[0] ?? null;
  })();
  orgLookup = { key, answer };
  return answer;
}

/** Sends this organization with every data request and applies its branding. */
export function applyOrg(org: Org | null) {
  setRequestOrg(platformOrg() ?? org?.id ?? null);
  if (!org) return;
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
