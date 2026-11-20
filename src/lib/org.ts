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

/** The URL decides the organization: its hostname, or ?org=slug. Dev builds can name a default slug. */
export async function resolveOrg(): Promise<Org | null> {
  const slug = new URLSearchParams(window.location.search).get('org') ?? import.meta.env.VITE_DEFAULT_ORG ?? null;
  const { data } = await supabase.rpc('resolve_org', { p_host: window.location.hostname, p_slug: slug });
  return ((data as Org[] | null) ?? [])[0] ?? null;
}

/** Sends this organization with every data request and applies its branding. */
export function applyOrg(org: Org | null) {
  setRequestOrg(platformOrg() ?? org?.id ?? null);
  if (!org) return;
  setTimezone(org.timezone);
  document.title = `${org.name} · Donor Base`;   // the product is Donor Base (Shulim, 2026-11-12)
  const root = document.documentElement.style;
  if (org.primary_color) {
    root.setProperty('--accent', org.primary_color);
    root.setProperty('--accent-2', org.primary_color);
  } else {
    root.removeProperty('--accent');
    root.removeProperty('--accent-2');
  }
}
