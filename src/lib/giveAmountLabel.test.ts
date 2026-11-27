import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Payment page (Shulim, 2026-11-27): with no preset amounts the amount box is the only one, so it says "Amount" in every
// language; with presets it stays "Other amount".
const give = readFileSync('src/pages/Give.tsx', 'utf8');

describe('payment page amount box label', () => {
  it('says Amount without presets and Other amount with them', () => {
    expect(give).toContain('placeholder={presets.length ? t.other : t.amount}');
    expect(give).toContain('aria-label={presets.length ? t.other : t.amount}');
  });
  it('has both words in English, Hebrew and Yiddish', () => {
    expect(give).toContain("amount: 'Amount', other: 'Other amount'");
    expect(give).toContain("amount: 'סכום', other: 'סכום אחר'");
    expect(give).toContain("amount: 'סכום', other: 'אן אנדער סכום'");
  });
});
