import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { voucherFields } from './schemas';

describe('voucher form', () => {
  it('shows our ref # and one fee amount, with no issuer ref. # or fee options (Moshe Henig, 2026-11-11)', () => {
    const names = voucherFields.map(f => f.name);
    expect(names).toEqual(expect.arrayContaining(['id', 'issuer_number', 'fee_flat']));
    expect(names).not.toEqual(expect.arrayContaining(['issuer_reference']));
    expect(names.filter(n => ['fee_type', 'fee_percent'].includes(n))).toEqual([]);
    expect(voucherFields.find(f => f.name === 'fee_flat')!.label).toBe('Fee ($)');
    const ref = voucherFields.find(f => f.name === 'id')!;
    expect(ref).toMatchObject({ label: 'Voucher ref #', readOnly: true });
    expect(ref.showIf).toBeUndefined();
  });

  it('opens with the next voucher ref # filled in, and shows the number given after saving', () => {
    const src = readFileSync(join(__dirname, '..', 'pages', 'Vouchers.tsx'), 'utf8');
    expect(src).toContain('onSaved={row => { setAdding(false); onSaved(); setSaved(row); }}');
    expect(src).toContain('<VoucherSavedNotice voucher={saved} shownRef={nextRef}');
    expect(src).toContain("supabase.rpc('next_voucher_ref')");
    expect(src).toContain('defaults={{ id: nextRef || undefined,');
  });
});
