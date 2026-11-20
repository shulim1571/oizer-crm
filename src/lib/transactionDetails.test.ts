// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { donationColumns, kindLabel } from '../pages/donationColumns';

// Readiness #58 (2026-11-15): $0.00 rather than a blank fee, "Batch deposit" for Batch, donor names link to the donor.
describe('transaction details', () => {
  const cols = donationColumns();
  it('shows $0.00 for a gift with no fee (but nothing for a failed charge)', () => {
    const fee = cols.find(c => c.key === 'fee')!;
    expect(fee.render!({ status: 'completed', fee: null, manual_fee: null })).toBe('$0.00');
    expect(fee.render!({ status: 'failed', fee: null })).toBe('');
  });
  it('calls a Batch a Batch deposit', () => {
    expect(kindLabel('Batch')).toBe('Batch deposit');
    expect(cols.find(c => c.key === 'type')!.value!({ status: 'completed', type: 'Batch' })).toBe('Batch deposit');
    expect(readFileSync('src/components/Pill.tsx', 'utf8')).toContain("'Batch deposit': 'blue'");
  });
  it('links a donor name to the donor', () => {
    expect(readFileSync('src/pages/donationColumns.tsx', 'utf8')).toContain('<Link to={`/donors/${r.donors.id}`} onClick={e => e.stopPropagation()}>{main}</Link>');
  });
});
