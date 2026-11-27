// Azure Maps Search Address (api-version 1.0) for address suggestions while typing (Shulim, 2026-11-25): US only,
// typeahead. The key (AZURE_MAPS_KEY) is added by the caller and never logged or returned.

export const AZURE_SEARCH_ADDRESS = 'https://atlas.microsoft.com/search/address/json';
export const MIN_QUERY = 3;
export const MAX_QUERY = 120;
export const MAX_SUGGESTIONS = 5;

/**
 * The organization's region for suggestions (Shulim, 2026-11-25), the setting address_region: one or more states, and
 * whether to show only addresses there or show them first. Null when not set.
 */
export interface Region { mode: 'only' | 'prefer'; states: string[] }

/** Roughly the middle of each state (and DC), to point Azure's ranking at the region. */
export const STATE_CENTERS: Record<string, [number, number]> = {
  AL: [32.8, -86.8], AK: [61.4, -152.3], AZ: [34.2, -111.7], AR: [34.9, -92.4], CA: [37.2, -119.7], CO: [39.0, -105.5],
  CT: [41.6, -72.7], DE: [39.0, -75.5], DC: [38.9, -77.0], FL: [28.6, -82.4], GA: [32.7, -83.4], HI: [20.8, -156.3],
  ID: [44.4, -114.6], IL: [40.0, -89.2], IN: [39.9, -86.3], IA: [42.1, -93.5], KS: [38.5, -98.4], KY: [37.5, -85.3],
  LA: [31.1, -92.0], ME: [45.4, -69.2], MD: [39.0, -76.8], MA: [42.3, -71.8], MI: [44.3, -85.4], MN: [46.3, -94.3],
  MS: [32.7, -89.7], MO: [38.4, -92.5], MT: [47.0, -109.6], NE: [41.5, -99.8], NV: [39.3, -116.6], NH: [43.7, -71.6],
  NJ: [40.2, -74.7], NM: [34.4, -106.1], NY: [42.9, -75.5], NC: [35.6, -79.4], ND: [47.5, -100.5], OH: [40.3, -82.8],
  OK: [35.6, -97.5], OR: [43.9, -120.6], PA: [40.9, -77.8], RI: [41.7, -71.5], SC: [33.9, -80.9], SD: [44.4, -100.2],
  TN: [35.9, -86.4], TX: [31.5, -99.3], UT: [39.3, -111.7], VT: [44.1, -72.7], VA: [37.5, -78.9], WA: [47.4, -120.5],
  WV: [38.6, -80.6], WI: [44.6, -89.9], WY: [43.0, -107.6],
};

/** The setting's value as a region: known two-letter states only; null when it's off or names no state. */
export function readRegion(v: unknown): Region | null {
  const r = v as { mode?: unknown; states?: unknown } | null;
  if (!r || (r.mode !== 'only' && r.mode !== 'prefer') || !Array.isArray(r.states)) return null;
  const states = [...new Set(r.states.map(x => String(x).trim().toUpperCase()).filter(x => x in STATE_CENTERS))];
  return states.length ? { mode: r.mode, states } : null;
}

/** What was typed, tidied, or null when it's too short or too long to look up. */
export function cleanQuery(q: unknown): string | null {
  if (typeof q !== 'string') return null;
  const t = q.replace(/\s+/g, ' ').trim();
  return t.length >= MIN_QUERY && t.length <= MAX_QUERY ? t : null;
}

/**
 * The request's query string, without the key (the caller appends subscription-key). With a region, Azure is pointed at
 * its first state (lat/lon only ranks, it doesn't limit) and asked for more, so enough are left after narrowing.
 */
export function searchParams(query: string, region: Region | null = null): URLSearchParams {
  const p = new URLSearchParams({
    'api-version': '1.0', query, typeahead: 'true', countrySet: 'US', limit: String(region ? 20 : MAX_SUGGESTIONS + 3), language: 'en-US',
  });
  const center = region ? STATE_CENTERS[region.states[0]] : undefined;
  if (center) { p.set('lat', String(center[0])); p.set('lon', String(center[1])); }
  return p;
}

export interface AzureAddress {
  streetNumber?: string; streetName?: string; municipality?: string; municipalitySubdivision?: string; localName?: string;
  countrySubdivision?: string; countrySubdivisionCode?: string; postalCode?: string; countryCode?: string; freeformAddress?: string;
}
export interface Suggestion { street: string; city: string; state: string; zip: string; one_line: string; two_lines: string }

/** "123 Main St, Brooklyn NY 11219", or on two lines: the one-field address layout donors and payees keep. */
export function formatSuggestion(s: Pick<Suggestion, 'street' | 'city' | 'state' | 'zip'>, oneLine: boolean): string {
  const line2 = [s.city, [s.state, s.zip].filter(Boolean).join(' ')].filter(Boolean).join(' ');
  return [s.street, line2].filter(Boolean).join(oneLine ? ', ' : '\n');
}

/**
 * Street addresses from Azure's results: US only, each with a street, city, two-letter state and 5-digit ZIP; places
 * that aren't addresses (a whole city or ZIP code) and repeats are left out.
 */
export function toSuggestions(data: unknown, region: Region | null = null): Suggestion[] {
  const results = (data as { results?: { type?: string; address?: AzureAddress }[] } | null)?.results;
  if (!Array.isArray(results)) return [];
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    const a = r?.address;
    if (!a || (a.countryCode && a.countryCode !== 'US') || !a.streetName) continue;
    if (r.type && !['Point Address', 'Address Range', 'Street', 'Cross Street'].includes(r.type)) continue;
    const street = [a.streetNumber, a.streetName].filter(Boolean).join(' ').trim();
    // The mailing city: Azure's local name where it has one (Brooklyn, not New York), else the first municipality name.
    const city = (a.localName || a.municipalitySubdivision || String(a.municipality ?? '').split(',')[0] || '').trim();
    const state = String(a.countrySubdivisionCode || a.countrySubdivision || '').trim().toUpperCase();
    const zip = String(a.postalCode ?? '').trim().slice(0, 5);
    if (!street || !city || !/^[A-Z]{2}$/.test(state) || !/^\d{5}$/.test(zip)) continue;
    const parts = { street, city, state, zip };
    const one_line = formatSuggestion(parts, true);
    if (seen.has(one_line)) continue;
    seen.add(one_line);
    out.push({ ...parts, one_line, two_lines: formatSuggestion(parts, false) });
  }
  if (!region) return out.slice(0, MAX_SUGGESTIONS);
  const inRegion = (x: Suggestion) => region.states.includes(x.state);
  // Only the region's addresses, or the region's first (each group keeps Azure's order).
  const ranked = region.mode === 'only' ? out.filter(inRegion) : [...out.filter(inRegion), ...out.filter(x => !inRegion(x))];
  return ranked.slice(0, MAX_SUGGESTIONS);
}
