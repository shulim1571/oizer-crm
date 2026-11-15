import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { feeDown } from './feeMath';

// Moshe Henig, 2026-11-15: fees round down to the cent, never up.
describe('fees round down', () => {
  it('drops anything past the cent', () => {
    expect(feeDown(1.095)).toBe(1.09);       // 3% of 36.50
    expect(feeDown(3.9999)).toBe(3.99);      // 3% of 133.33
    expect(feeDown(0.544)).toBe(0.54);
  });
  it('keeps exact cents, despite floating-point error', () => {
    expect(feeDown(0.29)).toBe(0.29);
    expect(feeDown(36.5 * 3 / 100)).toBe(1.09);
    expect(feeDown(18 * 3 / 100)).toBe(0.54);
    expect(feeDown(2.9)).toBe(2.9);
    expect(feeDown(0)).toBe(0);
  });
  it('is what the database and the voucher preview use', () => {
    const sql = readFileSync('supabase/migrations/20261222003500_fees_round_down.sql', 'utf8');
    expect(sql).toContain('select trunc(case r.fee_type');
    expect(sql).toContain('v_fee := coalesce(p_fee, trunc(case v.fee_type');
    expect(sql).not.toMatch(/round\(/);
    expect(readFileSync('src/pages/Vouchers.tsx', 'utf8')).toContain('feeDown(pctPart + Number(r.fee_flat))');
  });
});
