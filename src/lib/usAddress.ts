// Reading and writing a US address in the one-field layout donors and payees keep: the street line, then
// "City ST 12345-6789" (on a new line, or after ", " on one line). Moved here from the USPS check when that was removed
// (Shulim, 2026-11-25); nothing here calls any service.

export interface AddressParts { streetAddress: string; secondaryAddress?: string; city?: string; state?: string; ZIPCode?: string; ZIPPlus4?: string }
export interface UsAddress { streetAddress?: string; secondaryAddress?: string; city?: string; state?: string; ZIPCode?: string; ZIPPlus4?: string }

const SECONDARY = /\s+((?:apt|apartment|unit|suite|ste|fl|floor|rm|room|bldg|building|dept|#)\.?\s*#?\s*[\w-]+)$/i;

/** "123 Main St Apt 4\nBrooklyn, NY 11219" (or on one line, with commas) into its parts; null when it can't tell. */
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

/** An address in the field layout: street line, then "City ST 12345-6789" (newline, or ", " on one line). */
export function formatUsAddress(a: UsAddress, oneLine = false): string {
  const line1 = [a.streetAddress, a.secondaryAddress].filter(Boolean).join(' ');
  const zip = a.ZIPCode ? `${a.ZIPCode}${a.ZIPPlus4 ? `-${a.ZIPPlus4}` : ''}` : '';
  const line2 = [a.city, [a.state, zip].filter(Boolean).join(' ')].filter(Boolean).join(' ');
  return [line1, line2].filter(Boolean).join(oneLine ? ', ' : '\n');
}
