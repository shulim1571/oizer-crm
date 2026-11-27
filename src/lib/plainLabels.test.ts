import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { donorFields } from './schemas';

// Readiness #64 (2026-11-15): plain labels for fundraisers, donors and payees.
describe('plain labels', () => {
  it('says a fundraiser\'s campaign count includes archived and closed ones', () => {
    expect(readFileSync('src/pages/SimplePages.tsx', 'utf8')).toContain("active of ${r.campaign_count}${Number(r.campaign_count) > Number(r.active_count) ? ' (rest archived or closed)' : ''}");
  });
  it('names donors\' giving-fund accounts in plain words', () => {
    expect(donorFields.find(f => f.name === 'ojc_id')!.label).toBe('OJC account number');
    const d = readFileSync('src/pages/Donors.tsx', 'utf8');
    expect(d).not.toContain('OJC / Matbia');
    expect(d).toContain('<dt>Nadvan account number</dt>');
  });
  it('shows each payee\'s paid-to-date total', () => {
    const p = readFileSync('src/pages/Payees.tsx', 'utf8');
    expect(p).toContain("label: 'Paid to date'");
    expect(p).toContain("{isAdmin ? 'Paid to date' : 'Paid from your campaigns'}");
  });
});
