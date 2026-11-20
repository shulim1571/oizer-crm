// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PAYOUT_PRESETS } from '../pages/SimplePages';

// Readiness #42 (2026-11-15): quick filters on the Payouts list.
const by = (label: string) => PAYOUT_PRESETS.find(p => p.label === label)!.test;
describe('Payouts quick filters', () => {
  it('To pay: check payouts with no check printed yet', () => {
    expect(by('To pay')({ method: 'Check', check_number: null, processed_at: '2026-11-10' })).toBe(true);
    expect(by('To pay')({ method: 'Check', check_number: '1201', processed_at: '2026-11-10' })).toBe(false);
    expect(by('To pay')({ method: 'Zelle', check_number: null, processed_at: '2026-11-10' })).toBe(false);
  });
  it('Scheduled: waiting for their date', () => {
    expect(by('Scheduled')({ scheduled_for: '2026-12-01', processed_at: null })).toBe(true);
    expect(by('Scheduled')({ scheduled_for: '2026-12-01', processed_at: '2026-12-01' })).toBe(false);
  });
  it('Outstanding checks: printed, not cleared by the bank', () => {
    expect(by('Outstanding checks')({ check_number: '1201', cleared: false })).toBe(true);
    expect(by('Outstanding checks')({ check_number: '1201', cleared: true })).toBe(false);
  });
  it('are buttons above the list', () => {
    expect(readFileSync('src/pages/SimplePages.tsx', 'utf8')).toContain('presets={PAYOUT_PRESETS}');
    expect(readFileSync('src/components/CrudPage.tsx', 'utf8')).toContain('onClick={() => setPreset(v => (v === x.label ? null : x.label))}');
  });
});
