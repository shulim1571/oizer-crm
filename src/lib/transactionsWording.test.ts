import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Moshe Henig, 2026-11-10: the Transactions summary says "transaction(s)", not "gift(s)".
describe('Transactions summary wording', () => {
  const src = readFileSync('src/pages/Donations.tsx', 'utf8');
  const summary = src.slice(src.indexOf('function WeekSummary'), src.indexOf('export function NewDonation') > 0 ? src.indexOf('export function NewDonation') : undefined);
  it('says transactions, singular or plural', () => {
    expect(summary).toMatch(/live\.length === 1 \? 'Transaction' : 'Transactions'/);
    expect(summary).toMatch(/received transactions/);
    expect(summary).toMatch(/failed transactions\./);
  });
  it('no longer says gift in the summary', () => {
    expect(summary.slice(0, summary.indexOf('UNATTRIBUTED'))).not.toMatch(/gift/i);
    expect(src).not.toMatch(/failed gifts/);
  });
});
