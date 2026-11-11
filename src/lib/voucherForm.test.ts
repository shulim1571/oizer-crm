import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { voucherFields } from './schemas';

describe('voucher form', () => {
  it("has an issuer's ref. # separate from the batch #, and shows our ref # once the voucher exists", () => {
    const names = voucherFields.map(f => f.name);
    expect(names).toEqual(expect.arrayContaining(['id', 'issuer_number', 'issuer_reference']));
    const ref = voucherFields.find(f => f.name === 'id')!;
    expect(ref).toMatchObject({ label: 'Voucher ref #', readOnly: true });
    expect(ref.showIf).toBeUndefined();
    expect(voucherFields.find(f => f.name === 'issuer_reference')!.label).toBe("Issuer's ref. #");
  });

  it('opens with the next voucher ref # filled in, and shows the number given after saving', () => {
    const src = readFileSync(join(__dirname, '..', 'pages', 'Vouchers.tsx'), 'utf8');
    expect(src).toContain('onSaved={row => { setAdding(false); onSaved(); setSaved(row); }}');
    expect(src).toContain('<VoucherSavedNotice voucher={saved} shownRef={nextRef}');
    expect(src).toContain("supabase.rpc('next_voucher_ref')");
    expect(src).toContain('defaults={{ id: nextRef || undefined,');
  });
});
