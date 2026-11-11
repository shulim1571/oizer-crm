import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Moshe Henig, 2026-11-10: the Transactions summary says "transaction(s)", not "gift(s)". Since 2026-11-11 the
// summary is the totals line above the one Transactions list (the Last 7 Days tab became a date range).
describe('Transactions summary wording', () => {
  const src = readFileSync('src/pages/Donations.tsx', 'utf8');
  it('says transactions, singular or plural', () => {
    expect(src).toContain("transaction{data?.count === 1 ? '' : 's'}");
    expect(src).toMatch(/failed transactions\./);
  });
  it('no longer says gift in the summary', () => {
    const totals = src.slice(src.indexOf('<div className="totals-bar">'), src.indexOf('</div>', src.indexOf('<div className="totals-bar">')));
    expect(totals).not.toMatch(/gift/i);
    expect(src).not.toMatch(/failed gifts/);
  });
});
