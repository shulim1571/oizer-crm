import { formatUsAddress, parseUsAddress } from '../../supabase/functions/_shared/usps';

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
