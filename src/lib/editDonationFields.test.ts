import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { editDonationFields, newDonationFields } from './schemas';

// Moshe Henig, 2026-11-11: fields taken out of New Donation are gone everywhere else too.
const REMOVED = ['type', 'fee', 'collector_id', 'batch_id', 'funded', 'batch_status', 'batch_pending'];
const src = (p: string) => readFileSync(p, 'utf8');

describe('donation fields removed from New Donation', () => {
  it('are not on the Edit Donation form, which has the same fields and rules as New Donation', () => {
    expect(editDonationFields).toBe(newDonationFields);
    expect(editDonationFields.some(f => REMOVED.includes(f.name))).toBe(false);
  });

  it('open the edit form with those fields from Transactions and from a campaign page', () => {
    expect(src('src/pages/Donations.tsx')).toContain('fields={editDonationFields}');
    expect(src('src/pages/CampaignDetail.tsx')).toContain("title: 'Edit Donation', fields: editDonationFields }");
  });

  it('are not in bulk edit either', () => {
    const bulk = src('src/pages/TransactionBulk.tsx');
    const list = bulk.slice(bulk.indexOf('const BULK_FIELDS'), bulk.indexOf('];', bulk.indexOf('const BULK_FIELDS')));
    for (const n of REMOVED) expect(list).not.toContain(`'${n}'`);
    expect(list).toContain("'manual_fee'");
  });
});
