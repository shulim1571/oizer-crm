import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Readiness #30 (2026-11-15): "Apply fee difference" on a match short by processor fees.
describe('apply fee difference on the page', () => {
  it('is offered on a processor-fee match not applied yet, and calls the database', () => {
    const r = readFileSync('src/pages/Reconciliation.tsx', 'utf8');
    expect(r).toContain("{m.difference_type === 'processor_fees' && Number(m.difference) < 0 && !m.fee_applied_at && m.items.length > 0 &&");
    expect(r).toContain("await supabase.rpc('apply_fee_difference', { p_match: m.id });");
  });
});
