// USPS address standardization (Shulim, 2026-11-12). Pure helpers shared by the usps-address Edge Function and the
// portal: split a free-text US address into the parts USPS's Addresses API takes, and write USPS's answer back in
// the same one-field layout. Endpoints and field names from USPS's published examples (github.com/USPS/api-examples):
// POST /oauth2/v3/token (JSON client_credentials), GET /addresses/v3/address. Credentials are per organization and
// stored encrypted in the database; nothing here holds a key.

export interface AddressParts { streetAddress: string; secondaryAddress?: string; city?: string; state?: string; ZIPCode?: string; ZIPPlus4?: string }
export interface UspsAddress { streetAddress?: string; secondaryAddress?: string; city?: string; state?: string; ZIPCode?: string; ZIPPlus4?: string }

export const USPS_HOSTS = { production: 'https://apis.usps.com', test: 'https://apis-tem.usps.com' } as const;
export type UspsEnvironment = keyof typeof USPS_HOSTS;

const SECONDARY = /\s+((?:apt|apartment|unit|suite|ste|fl|floor|rm|room|bldg|building|dept|#)\.?\s*#?\s*[\w-]+)$/i;

/** "123 Main St Apt 4\nBrooklyn, NY 11219" (or on one line, with commas) into USPS's parts; null when it can't tell. */
export function parseUsAddress(text: string): AddressParts | null {
  const parts = String(text ?? '').split(/[\n,]+/).map(p => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (parts.length === 0) return null;
  let city: string | undefined, state: string | undefined, zip: string | undefined, plus4: string | undefined;
  const last = parts[parts.length - 1];
  const m = last.match(/^(.*?)\s*\b([A-Za-z]{2})\s+(\d{5})(?:-?(\d{4}))?$/) ?? last.match(/^(.*?)\s*\b([A-Za-z]{2})$/);
  if (m && parts.length >= 2) {
    parts.pop();
    city = m[1].trim() || undefined;
    state = m[2].toUpperCase();
    zip = m[3];
    plus4 = m[4];
    if (!city && parts.length >= 2) city = parts.pop();
  } else if (/^\d{5}(-\d{4})?$/.test(last) && parts.length >= 2) {
    parts.pop();
    [zip, plus4] = last.split('-');
  }
  if (parts.length === 0) return null;
  let street = parts[0];
  let secondary = parts.slice(1).join(' ') || undefined;
  const s = street.match(SECONDARY);
  if (s && !secondary) { secondary = s[1]; street = street.slice(0, s.index).trim(); }
  if (!/\d/.test(street) && !/p\.?\s*o\.?\s*box/i.test(street)) return null;   // no house number or PO box: not a street line
  if (!state && !zip) return null;
  if (!zip && !city) return null;
  return { streetAddress: street, ...(secondary ? { secondaryAddress: secondary } : {}), ...(city ? { city } : {}), ...(state ? { state } : {}),
    ...(zip ? { ZIPCode: zip } : {}), ...(plus4 ? { ZIPPlus4: plus4 } : {}) };
}

/** The query string for GET /addresses/v3/address. */
export function addressQuery(p: AddressParts): string {
  const q = new URLSearchParams();
  for (const k of ['streetAddress', 'secondaryAddress', 'city', 'state', 'ZIPCode', 'ZIPPlus4'] as const) if (p[k]) q.set(k, p[k]!);
  return q.toString();
}

/** USPS's answer as the field shows addresses: street line, then "CITY ST 12345-6789" (newline, or ", " on one line). */
export function formatUsAddress(a: UspsAddress, oneLine = false): string {
  const line1 = [a.streetAddress, a.secondaryAddress].filter(Boolean).join(' ');
  const zip = a.ZIPCode ? `${a.ZIPCode}${a.ZIPPlus4 ? `-${a.ZIPPlus4}` : ''}` : '';
  const line2 = [a.city, [a.state, zip].filter(Boolean).join(' ')].filter(Boolean).join(' ');
  return [line1, line2].filter(Boolean).join(oneLine ? ', ' : '\n');
}

/** What DPV confirmation means, in words (Y: deliverable; S/D: deliverable but the apartment or suite is wrong or missing). */
export function deliverability(dpv: string | undefined): string {
  switch (dpv) {
    case 'Y': return 'USPS confirms mail can be delivered here.';
    case 'S': return 'USPS knows the building, but not the apartment or suite given.';
    case 'D': return 'USPS knows the building; it needs an apartment or suite number.';
    case 'N': return 'USPS can\'t confirm mail can be delivered here.';
    default: return '';
  }
}
