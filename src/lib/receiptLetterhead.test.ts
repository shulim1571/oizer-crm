import { describe, expect, it } from 'vitest';
import { isLetterhead, letterheadPage, SAMPLE_RECEIPT, type ReceiptLayout } from './receiptLetterhead';

// Shulim, 2026-11-12: Oizer's receipt on its own letterhead, from the organization's stored layout. Sample data only.
const layout: ReceiptLayout = {
  style: 'letterhead', enabled: false,
  hebrew: { left: 98, right: 514, lines: [{ top: 202, text: 'מו"ה {hebrew_name} הי"ו' }, { top: 228, text: 'בסך {amount}' }, { top: 268, text: 'עבור {campaign}' }] },
  english: { left: 99, lines: [{ top: 420, text: 'Dear {name},' }], signer_title: 'Director', signer: 'Sample Director' },
  stub: { amount: [318, 697], date: [452, 697], receipt_number: [52, 722], donor: [160, 612] },
};

describe('receipt letterhead', () => {
  it('fills in the donor, amount, campaign and date where the layout says', () => {
    const html = letterheadPage({ ...SAMPLE_RECEIPT, receipt_date: '2026-11-12' }, { name: 'Sample Org' }, layout, null);
    expect(html).toContain('<span class="fill">ר&#39; שמואל דוגמא</span>');
    expect(html).toContain('<span class="fill">$180.00</span>');
    expect(html).toContain('<span class="fill">Sample Campaign</span>');
    expect(html).toContain('<span class="fill">Mr. Sample Donor</span>');
    expect(html).toContain('top:697pt;left:452pt');
    expect(html).toContain('11/12/2026');
    expect(html).toContain('Receipt SAMPLE-0001');
    expect(html).toContain('Sample Director');
  });
  it('escapes what it fills in, marks voided receipts, and only takes a complete layout', () => {
    const html = letterheadPage({ ...SAMPLE_RECEIPT, donor_name: '<b>x</b>', status: 'voided', void_reason: 'Sample' }, { name: 'O' }, layout, null);
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('VOID · Sample');
    expect(isLetterhead(layout)).toBe(true);
    expect(isLetterhead({ style: 'letterhead' })).toBe(false);
    expect(isLetterhead(null)).toBe(false);
  });
  it('leaves the Hebrew name line out when the donor has no Hebrew name, and never uses the English name there', () => {
    const html = letterheadPage({ ...SAMPLE_RECEIPT, hebrew_name: null }, { name: 'Sample Org' }, layout, null);
    expect(html).not.toContain('מו&quot;ה');
    expect(html).not.toContain('top:202pt');
    expect(html).toContain('<span class="fill">Mr. Sample Donor</span>');   // still in the English greeting
    const hebrewBlock = html.match(/<div class="t he"[^]*?<\/div>/g)?.join('') ?? '';
    expect(hebrewBlock).not.toContain('Sample Donor');   // only in the English greeting and on the stub
    expect(html).toContain('עבור <span class="fill">Sample Campaign</span>');   // the other Hebrew lines stay
    const blank = letterheadPage({ ...SAMPLE_RECEIPT, hebrew_name: '  ' }, { name: 'Sample Org' }, layout, null);
    expect(blank).not.toContain('top:202pt');
  });
  it("prints the donor's English name and mailing address on the stub", () => {
    const html = letterheadPage(SAMPLE_RECEIPT, { name: 'Sample Org' }, layout, null);
    expect(html).toContain('class="t stub-donor" style="top:612pt;left:160pt');
    expect(html).toContain('<div class="fill">Mr. Sample Donor</div><div>123 Sample St Apt 4</div><div>Brooklyn NY 11219</div>');
    const noAddress = letterheadPage({ ...SAMPLE_RECEIPT, donor_address: null }, { name: 'Sample Org' }, layout, null);
    expect(noAddress).toContain('<div class="fill">Mr. Sample Donor</div></div>');
    const noSpot = letterheadPage(SAMPLE_RECEIPT, { name: 'Sample Org' }, { ...layout, stub: { amount: [1, 1], date: [2, 2] } }, null);
    expect(noSpot).not.toContain('stub-donor');
  });
});

// Moshe's receipt design (2026-11-22): the text is printed on the template; only the blanks are filled, each placed by
// its baseline so values line up with the printed words ("Amount", "Date" on the stub). Sample data only.
import { estimatedWidth, fieldText, isLetterhead as isLetterheadFill, letterheadPage as page } from './receiptLetterhead';
describe('fill-in receipt template', () => {
  const layout = { style: 'letterhead', mode: 'fill', enabled: false, hebrew: { left: 0, right: 0, lines: [] }, english: { left: 0, lines: [] }, stub: { amount: [0, 0], date: [0, 0] },
    fields: [
      { key: 'hebrew_name', x: 443.3, y: 207.9, size: 13, anchor: 'middle', bold: true, hebrew: true, max_width: 86, min_size: 7 },
      { key: 'amount_number', x: 274.5, y: 232.9, size: 12, bold: true, max_width: 33, min_size: 8 },
      { key: 'amount', x: 318, y: 710.5, size: 14, bold: true },
      { key: 'date', x: 451.5, y: 710.5, size: 14, bold: true },
      { key: 'name', x: 129.5, y: 422.8, size: 12, bold: true, suffix: ',' },
      { key: 'donor_block', x: 160, y: 628, size: 10.5 },
    ] } as never;
  const r = { donor_title: 'Mr.', donor_name: 'Sample Donor', hebrew_name: "ר' שמואל דוגמא", amount: 12500, receipt_date: '2026-11-22', campaign_name: 'Sample', donor_address: '1 Sample St\nBrooklyn NY 11219', status: 'issued' };
  it('is a letterhead layout and fills each blank', () => {
    expect(isLetterheadFill(layout)).toBe(true);
    expect([fieldText('amount', r), fieldText('amount_number', r), fieldText('date', r), fieldText('name', r)]).toEqual(['$12,500.00', '12,500', '11/22/2026', 'Mr. Sample Donor']);
    expect(fieldText('amount_number', { amount: 36.5 })).toBe('36.50');
  });
  it('puts the stub amount and date on the same baseline as the printed words, and writes nothing else', () => {
    const html = page(r, { name: 'Sample Org' }, layout, null);
    expect(html).toContain('<text x="318" y="710.5" font-size="14" text-anchor="start" class="b">$12,500.00</text>');
    expect(html).toContain('<text x="451.5" y="710.5" font-size="14" text-anchor="start" class="b">11/22/2026</text>');
    expect(html).toContain('>Mr. Sample Donor,</text>');
    expect(html).toContain('>1 Sample St</text>');
    expect(html).not.toContain('This is to acknowledge');                       // the template carries the sentences
  });
  it('shrinks a long value to fit its blank, but not below the field\'s smallest size', () => {
    const html = page({ ...r, hebrew_name: "ר' אברהם יצחק דוגמא-ארוכה-מאוד" }, { name: 'S' }, layout, null);
    const size = Number(/font-size="([\d.]+)" text-anchor="middle"[^>]*class="b he"/.exec(html)?.[1]);
    expect(size).toBe(7);
    expect(estimatedWidth("ר' שמואל דוגמא", 13, true)).toBeGreaterThan(86);     // measured: about 90.7pt at 13pt
  });
});
