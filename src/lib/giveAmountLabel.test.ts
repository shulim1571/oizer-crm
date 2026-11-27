import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Payment page (Shulim, 2026-11-27): with no preset amounts the amount box is the only one, so it shows just the $ sign and
// an empty box (no placeholder: "Amount" would repeat the section title), still labelled "Amount" for screen readers in
// every language; with presets it stays "Other amount".
const give = readFileSync('src/pages/Give.tsx', 'utf8');

describe('payment page amount box label', () => {
  it('is empty without presets and says Other amount with them, labelled for screen readers either way', () => {
    expect(give).toContain('placeholder={presets.length ? t.other : undefined}');
    expect(give).toContain('aria-label={presets.length ? t.other : t.amount}');
  });
  it('has both words in English, Hebrew and Yiddish', () => {
    expect(give).toContain("amount: 'Amount', other: 'Other amount'");
    expect(give).toContain("amount: 'סכום', other: 'סכום אחר'");
    expect(give).toContain("amount: 'סכום', other: 'אן אנדער סכום'");
  });
});
