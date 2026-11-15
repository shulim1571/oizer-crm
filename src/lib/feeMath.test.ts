import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { feeUp } from './feeMath';

// Moshe Henig, 2026-11-15: fees round up to the cent, so the net rounds down. (Replaces the earlier round-down rule.)
describe('fees round up, nets round down', () => {
  it('takes any part of a cent up to the next cent', () => {
    expect(feeUp(1.095)).toBe(1.1);        // 3% of 36.50: net 35.40
    expect(feeUp(0.3003)).toBe(0.31);      // 3% of 10.01: net 9.70
    expect(feeUp(3.9999)).toBe(4);
  });
  it('keeps exact cents, despite floating-point error', () => {
    expect(feeUp(0.07)).toBe(0.07);
    expect(feeUp(18 * 3 / 100)).toBe(0.54);
    expect(feeUp(2.9)).toBe(2.9);
    expect(feeUp(0)).toBe(0);
  });
  it('is what the database and the voucher preview use', () => {
    const sql = readFileSync('supabase/migrations/20261222003600_fees_round_up.sql', 'utf8');
    expect(sql).toContain('select round(ceil(p * 100) / 100, 2)');
    expect(sql).toContain('select public.fee_up(case r.fee_type');
    expect(sql).toContain('v_fee := coalesce(p_fee, public.fee_up(case v.fee_type');
    expect(sql).not.toMatch(/trunc\(/);
    expect(sql).toContain('else round(v_fee_total * v_amount / v_total, 2) end;');   // splits divide a recorded fee
    expect(readFileSync('src/pages/Vouchers.tsx', 'utf8')).toContain('feeUp(pctPart + Number(r.fee_flat))');
  });
});
