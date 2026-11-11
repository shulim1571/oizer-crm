import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { donationFields, newDonationFields } from './schemas';

// Moshe Henig, 2026-11-11: the New Donation form "looks messy". Same fields and rules, grouped into sections.
const shown = (name: string, payment_method: string) => {
  const f = newDonationFields.find(x => x.name === name)!;
  return !f.showIf || f.showIf({ payment_method });
};

describe('New Donation layout', () => {
  it('groups the fields into Gift, Payment and Donor, in that order, then Notes and the folded accounting fields', () => {
    const main = newDonationFields.filter(f => !f.advanced);
    expect(main.map(f => `${f.section ?? '-'}:${f.name}`)).toEqual([
      'Gift:campaign_id', 'Gift:amount',
      'Payment:payment_method', 'Payment:manual_fee', 'Payment:check_number', 'Payment:check_date', 'Payment:post_dated', 'Payment:delivered',
      'Donor:donor_id', 'Donor:name', 'Donor:phone', 'Donor:email', 'Donor:anonymous',
      '-:notes', '-:status',
    ]);
    // Moshe Henig, 2026-11-11: no Type, Status at the bottom, only Source, Account and Timestamp under Advanced.
    expect(newDonationFields.filter(f => f.advanced).map(f => f.name)).toEqual(['source', 'account_id', 'created_at']);
    expect(newDonationFields.some(f => ['type', 'collector_id', 'fee'].includes(f.name))).toBe(false);
  });

  it('keeps every field rule as it was', () => {
    for (const n of ['check_number', 'check_date', 'post_dated']) { expect(shown(n, 'Check')).toBe(true); expect(shown(n, 'Cash')).toBe(false); }
    expect(shown('delivered', 'Cash')).toBe(true);
    expect(shown('delivered', 'Zelle')).toBe(false);
    expect(newDonationFields.find(f => f.name === 'manual_fee')!.showIf).toBeUndefined();
    expect(newDonationFields.some(f => ['batch_id', 'funded', 'batch_status', 'batch_pending'].includes(f.name))).toBe(false);
    expect(newDonationFields.filter(f => f.required).map(f => f.name).sort()).toEqual(['amount', 'campaign_id', 'status']);
    // The edit form is untouched by the new sections.
    expect(donationFields.some(f => f.section)).toBe(false);
  });

  it('draws sections as titled groups on two columns, with each section’s checkboxes on one line', () => {
    const form = readFileSync('src/components/RecordForm.tsx', 'utf8');
    expect(form).toMatch(/<fieldset key=\{t\} className="form-section">\s*<legend>\{t\}<\/legend>\s*<div className="fields two">/);
    expect(form).toContain('<div className="form-checks">{boxes.map(fieldBox)}</div>');
    expect(form).toContain("if (!main.some(f => f.section)) return <div className=\"fields\">{main.map(fieldBox)}</div>;");   // other forms unchanged
  });
});

describe('Payment Method on New Donation (Moshe Henig, 2026-11-11: like the Campaign dropdown)', () => {
  it('is a searchable dropdown of the organization’s payment methods, like Campaign', () => {
    const pm = newDonationFields.find(f => f.name === 'payment_method')!;
    const campaign = newDonationFields.find(f => f.name === 'campaign_id')!;
    expect(pm.type).toBe('search');
    expect(campaign.type).toBe('search');
    expect(pm.freeText).toBeUndefined();
    expect(typeof pm.options).toBe('function');
    // Edit Donation keeps its typed box, for older donations with methods outside the list.
    expect(donationFields.find(f => f.name === 'payment_method')!.type).toBe('select');
  });
});
