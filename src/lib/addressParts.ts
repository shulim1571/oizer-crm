import { formatUsAddress, parseUsAddress } from './usAddress';

/** The parts of a US address as the editor shows them; what's kept on the donor is still one address field. */
export interface AddressFields { street: string; unit: string; city: string; state: string; zip: string }

/** Splits a stored address into the editor's boxes; anything it can't read goes into Street as it is. */
export function splitAddress(text: string | null | undefined): AddressFields {
  const p = parseUsAddress(String(text ?? ''));
  if (!p) return { street: String(text ?? '').replace(/\s*\n\s*/g, ', ').trim(), unit: '', city: '', state: '', zip: '' };
  return { street: p.streetAddress, unit: p.secondaryAddress ?? '', city: p.city ?? '', state: p.state ?? '', zip: [p.ZIPCode, p.ZIPPlus4].filter(Boolean).join('-') };
}

/** Joins the boxes back into the one address field: "street apt, city ST 12345" on two lines, as elsewhere. */
export function joinAddress(a: AddressFields): string {
  const [zip, plus4] = a.zip.trim().split('-');
  return formatUsAddress({
    streetAddress: a.street.trim(), secondaryAddress: a.unit.trim() || undefined, city: a.city.trim() || undefined,
    state: a.state.trim().toUpperCase() || undefined, ZIPCode: zip || undefined, ZIPPlus4: plus4 || undefined,
  });
}

/** What's wrong with the boxes, if anything: a two-letter state and a 5-digit (or ZIP+4) ZIP. */
export function addressProblem(a: AddressFields): string | null {
  if (a.state.trim() && !/^[A-Za-z]{2}$/.test(a.state.trim())) return 'Use the two-letter state, for example NY.';
  if (a.zip.trim() && !/^\d{5}(-\d{4})?$/.test(a.zip.trim())) return 'A ZIP is 5 digits, or 5+4 like 11219-1234.';
  return null;
}
