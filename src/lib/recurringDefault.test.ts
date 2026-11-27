import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Moshe Henig, 2026-11-10: a new recurring charge defaults to a set number of payments, not "until I cancel",
// on the payment page, in Charge a card and when setting one up on a saved card.
describe('new recurring charges', () => {
  for (const file of ['src/pages/Give.tsx', 'src/pages/Payments.tsx', 'src/pages/Recurring.tsx']) {
    it(`default to a set number of payments in ${file}`, () => {
      const src = readFileSync(file, 'utf8');
      expect(src).not.toMatch(/fixed: false/);
      expect(src).toMatch(/fixed: true, count: '12'/);
      // The set-number choice is listed first.
      expect(src).toMatch(/<option value="n">[^<]*<\/option><option value="(until|open)">/);
    });
  }
});
