import { describe, expect, it } from 'vitest';
import { donationFields, newDonationFields } from './schemas';

// Moshe Henig, 2026-11-10: the New Donation form.
const field = (name: string) => newDonationFields.find(f => f.name === name);
const shown = (name: string, payment_method: string | null) => {
  const f = field(name);
  return !!f && (!f.showIf || f.showIf({ payment_method }));
};

describe('New Donation form', () => {
  it('shows the check fields only for a check', () => {
    for (const n of ['check_number', 'post_dated', 'check_date']) {
      expect(shown(n, 'Check')).toBe(true);
      expect(shown(n, 'check')).toBe(true);
      expect(shown(n, 'Cash')).toBe(false);
      expect(shown(n, 'Credit Card')).toBe(false);
      expect(shown(n, null)).toBe(false);
    }
  });

  it('shows Delivered only for cash or a check', () => {
    expect(shown('delivered', 'Cash')).toBe(true);
    expect(shown('delivered', 'Check')).toBe(true);
    expect(shown('delivered', 'Zelle')).toBe(false);
    expect(shown('delivered', '')).toBe(false);
    expect(field('delivered')?.advanced).toBe(false);
  });

  it('has no batch fields and no Batch type: vouchers have their own form', () => {
    for (const n of ['batch_id', 'funded', 'batch_status', 'batch_pending']) expect(field(n)).toBeUndefined();
    expect((field('type')?.options as { value: string }[]).map(o => o.value)).toEqual(['Payment']);
  });

  it('always shows Manual fee, whatever the method', () => {
    const f = field('manual_fee')!;
    expect(f.showIf).toBeUndefined();
    expect(f.advanced).toBe(false);
  });

  it('leaves the Edit Donation form whole, so batch rows can still be corrected', () => {
    expect(donationFields.map(f => f.name)).toEqual(expect.arrayContaining(['batch_id', 'funded', 'batch_status', 'batch_pending', 'check_date']));
    expect(donationFields.some(f => f.showIf)).toBe(false);
  });
});
