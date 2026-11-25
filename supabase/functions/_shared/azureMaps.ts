// Azure Maps Search Address (api-version 1.0) for address suggestions while typing (Shulim, 2026-11-25): US only,
// typeahead. The key (AZURE_MAPS_KEY) is added by the caller and never logged or returned.

export const AZURE_SEARCH_ADDRESS = 'https://atlas.microsoft.com/search/address/json';
export const MIN_QUERY = 3;
export const MAX_QUERY = 120;
export const MAX_SUGGESTIONS = 5;

/** What was typed, tidied, or null when it's too short or too long to look up. */
export function cleanQuery(q: unknown): string | null {
  if (typeof q !== 'string') return null;
  const t = q.replace(/\s+/g, ' ').trim();
  return t.length >= MIN_QUERY && t.length <= MAX_QUERY ? t : null;
}

/** The request's query string, without the key (the caller appends subscription-key). */
export function searchParams(query: string): URLSearchParams {
  return new URLSearchParams({
    'api-version': '1.0', query, typeahead: 'true', countrySet: 'US', limit: String(MAX_SUGGESTIONS + 3), language: 'en-US',
  });
}

export interface AzureAddress {
  streetNumber?: string; streetName?: string; municipality?: string; municipalitySubdivision?: string; localName?: string;
  countrySubdivision?: string; countrySubdivisionCode?: string; postalCode?: string; countryCode?: string; freeformAddress?: string;
}
export interface Suggestion { street: string; city: string; state: string; zip: string; one_line: string; two_lines: string }

/** "123 Main St, Brooklyn NY 11219", or on two lines, the same shape as the USPS check's "Use this". */
export function formatSuggestion(s: Pick<Suggestion, 'street' | 'city' | 'state' | 'zip'>, oneLine: boolean): string {
  const line2 = [s.city, [s.state, s.zip].filter(Boolean).join(' ')].filter(Boolean).join(' ');
  return [s.street, line2].filter(Boolean).join(oneLine ? ', ' : '\n');
}

/**
 * Street addresses from Azure's results: US only, each with a street, city, two-letter state and 5-digit ZIP; places
 * that aren't addresses (a whole city or ZIP code) and repeats are left out.
 */
export function toSuggestions(data: unknown): Suggestion[] {
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
    if (out.length >= MAX_SUGGESTIONS) break;
  }
  return out;
}
