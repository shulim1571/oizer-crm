import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Moshe Henig, 2026-11-10: the payment page says "ACH", not "bank account", in every language, and its payment
// options sit on one row.
describe('payment page method labels', () => {
  it('call the bank option ACH in English, Hebrew and Yiddish', () => {
    const en = readFileSync('src/pages/PayMethods.tsx', 'utf8');
    const give = readFileSync('src/pages/Give.tsx', 'utf8');
    expect(en).toMatch(/bank: 'ACH'/);
    expect([...give.matchAll(/\bbank: '([^']*)'/g)].map(m => m[1])).toEqual(['ACH', 'ACH']);
    expect(give).not.toMatch(/bank account|חשבון הבנק|באנק אקאונט וועט/i);
  });

  it('keep the payment options on one row', () => {
    const css = readFileSync('src/styles.css', 'utf8');
    expect(css).toMatch(/\.pay-methods \{[^}]*flex-wrap: nowrap/);
  });
});
