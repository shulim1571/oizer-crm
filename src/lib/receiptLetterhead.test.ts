import { describe, expect, it } from 'vitest';
import { isLetterhead, letterheadPage, SAMPLE_RECEIPT, type ReceiptLayout } from './receiptLetterhead';

// Shulim, 2026-11-12: Oizer's receipt on its own letterhead, from the organization's stored layout. Sample data only.
const layout: ReceiptLayout = {
  style: 'letterhead', enabled: false,
  hebrew: { left: 98, right: 514, lines: [{ top: 202, text: 'מו"ה {hebrew_name} הי"ו' }, { top: 228, text: 'בסך {amount}' }, { top: 268, text: 'עבור {campaign}' }] },
  english: { left: 99, lines: [{ top: 420, text: 'Dear {name},' }], signer_title: 'Director', signer: 'Sample Director' },
  stub: { amount: [318, 697], date: [452, 697], receipt_number: [52, 722] },
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
});
