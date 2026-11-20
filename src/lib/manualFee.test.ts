import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { manualFeeProblem } from './schemas';

// Readiness #16 (2026-11-15): a manual fee runs from $0 to the amount; blank uses the payment method's preset.
describe('manual fee on the donation form', () => {
  it('takes blank (the preset) and anything from $0 to the amount', () => {
    expect(manualFeeProblem('', { amount: 100 })).toBeNull();
    expect(manualFeeProblem(null, { amount: 100 })).toBeNull();
    expect(manualFeeProblem('0', { amount: 100 })).toBeNull();
    expect(manualFeeProblem(100, { amount: '100' })).toBeNull();
  });

  it('says what is wrong with a fee below $0 or above the amount', () => {
    expect(manualFeeProblem(-1, { amount: 100 })).toMatch(/below \$0/);
    expect(manualFeeProblem('100.01', { amount: 100 })).toMatch(/more than the amount/);
    expect(manualFeeProblem('abc', { amount: 100 })).toMatch(/below \$0/);
  });

  it('is checked before saving, and a blank box is saved as blank, not 0', () => {
    const form = readFileSync('src/components/RecordForm.tsx', 'utf8');
    expect(form).toContain('const problem = f.validate(values[f.name], values);');
    expect(form).toContain("if (v === '' || v === undefined) v = null;");
    expect(readFileSync('src/lib/schemas.ts', 'utf8')).toContain("type: 'number', help: 'Leave blank to use the payment method\\'s fee.', validate: manualFeeProblem }");
  });
});
