import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The address finder on the public payment page (Moshe, 2026-11-25). Sample data only.
describe('payment page address', () => {
  const give = readFileSync('src/pages/Give.tsx', 'utf8');
  it('gives US donors Street / Apt / City / State / ZIP with suggestions for this campaign, ZIP still required', () => {
    expect(give).toContain("{d.country === 'USA' ? (");
    expect(give).toContain('<AddressBoxes value={d.address} campaign={String(data.campaign.id)} zipRequired');
    expect(give).toContain("onChange={(joined, a) => setD(x => ({ ...x, address: joined, zip: a.zip, street: [a.street, a.unit].filter(Boolean).join(' ') }))} />");
  });
  it('keeps the free-text address and postal code for other countries', () => {
    expect(give).toContain('<label className="field"><span dir="auto">{zipLabel} *</span><input required dir="ltr" value={d.zip} onChange={set(\'zip\')} autoComplete="postal-code" /></label>');
  });
  it('labels the boxes in the page\'s language', () => {
    for (const w of ["street: 'Street address (optional)'", "street: 'רחוב ומספר (רשות)'", "street: 'גאס און נומער (אויב געוואלט)'"]) expect(give).toContain(w);
  });
  it('sends the street line alone as the card processor\'s billing street', () => {
    expect(readFileSync('supabase/functions/give/index.ts', 'utf8')).toContain('xBillStreet: d.street || d.address || undefined,');
  });
});
