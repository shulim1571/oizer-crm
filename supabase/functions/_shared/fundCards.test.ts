import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fundCardMessage, fundCvvOk, fundCvvProblem } from './fundCards';

// Moshe Henig, 2026-11-11: Pledger and Donors Fund test payments failed. Sola answered "Invalid Account Setup" (its
// account isn't set up for those funds) and once "Invalid CVV Length (4)" for Donors Fund.
describe('fund cards', () => {
  it('take a 3-digit CVV for Donors Fund, 3 or 4 for the others', () => {
    expect(fundCvvOk('Donors Fund', '123')).toBe(true);
    expect(fundCvvOk('Donors Fund', '1234')).toBe(false);
    expect(fundCvvOk('Pledger', '1234')).toBe(true);
    expect(fundCvvOk('Pledger', '12')).toBe(false);
    expect(fundCvvProblem('Donors Fund')).toBe('Enter the Donors Fund CVV (3 digits).');
  });

  it('tell the donor clearly why a fund card failed', () => {
    expect(fundCardMessage('Pledger', { xErrorCode: '01298', xError: 'Invalid Account Setup (PL). Contact Support.' }))
      .toBe("Pledger cards can't be used on this page right now. Please choose another way to pay, or contact the organization.");
    expect(fundCardMessage('Donors Fund', { xErrorCode: '01489', xError: 'Invalid CVV Length (4)' }))
      .toBe("The Donors Fund card's CVV wasn't accepted. Please check it (3 digits) and try again.");
    expect(fundCardMessage('Pledger', { xError: 'Grant type not supported for this card' })).toBe("That number isn't a Pledger card. Please check the card number.");
    expect(fundCardMessage('OJC', { xError: 'Something new' })).toBe('The OJC card wasn\'t accepted (Something new). Please check the details or choose another way to pay.');
  });

  it('are checked the same way by the payment page and all three payment functions', () => {
    for (const f of ['give', 'payments', 'recurring-charges']) {
      expect(readFileSync(`supabase/functions/${f}/index.ts`, 'utf8')).toContain('if (need.cvv && !fundCvvOk(p.program, p.daf_cvv)) return fundCvvProblem(p.program);');
    }
    expect(readFileSync('supabase/functions/give/index.ts', 'utf8')).toContain("error: b.method === 'daf' ? fundCardMessage(b.program, result) :");
    expect(readFileSync('src/pages/PayMethods.tsx', 'utf8')).toContain("(program === 'Donors Fund' ? /^\\d{3}$/ : /^\\d{3,4}$/).test(v.cvv)");
  });
});
