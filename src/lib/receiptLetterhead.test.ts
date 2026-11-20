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
