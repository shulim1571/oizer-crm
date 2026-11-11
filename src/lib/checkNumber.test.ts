import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { donationFields, fundraiserDonationFields, newDonationFields } from './schemas';

// Moshe Henig, 2026-11-11: "add on for check payment number a field for check number". Donations already had
// Check # (check_number); it now shows only for a check in every donation form, and in the lists.
const shownFor = (fields: typeof donationFields, payment_method: string) => {
  const f = fields.find(x => x.name === 'check_number')!;
  return !f.showIf || f.showIf({ payment_method });
};

describe('Check # on donations', () => {
  it('is one field, check_number, in the new, edit and fundraiser forms, shown only for a check', () => {
    for (const fields of [newDonationFields, donationFields, fundraiserDonationFields]) {
      expect(fields.filter(f => f.name === 'check_number')).toHaveLength(1);
      expect(shownFor(fields, 'Check')).toBe(true);
      expect(shownFor(fields, 'Cash')).toBe(false);
      expect(shownFor(fields, 'Zelle')).toBe(false);
    }
  });

  it('is a filterable column in the transaction lists, and found by search', () => {
    expect(readFileSync('src/pages/donationColumns.tsx', 'utf8'))
      .toContain("{ key: 'check_number', label: 'Check #', optional: true, filter: { column: 'check_number', type: 'text' } }");
    expect(readFileSync('src/pages/Donations.tsx', 'utf8')).toContain('`check_number.ilike.${like}`');
  });
});
