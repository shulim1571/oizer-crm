// Fund (DAF) cards: OJC, Pledger, Matbia, Donors Fund. Shared by the give, payments and recurring-charges functions.

/** CVV digits each fund takes. Sola refuses a 4-digit Donors Fund CVV ("Invalid CVV Length (4)", 2026-11-11). */
export const FUND_CVV: Record<string, RegExp> = { 'Donors Fund': /^\d{3}$/ };
export const fundCvvOk = (program: string | undefined, cvv: string | undefined) => (FUND_CVV[program ?? ''] ?? /^\d{3,4}$/).test(cvv ?? '');
export const fundCvvProblem = (program: string | undefined) => (FUND_CVV[program ?? ''] ? `Enter the ${program} CVV (3 digits).` : 'Enter the CVV.');

/**
 * What a donor is told when Sola doesn't accept a fund card (Moshe Henig, 2026-11-11: a clear error instead of
 * Sola's own text). Error 01298 "Invalid Account Setup" means the organization's Sola account isn't set up for that
 * fund, which the donor can't fix.
 */
export function fundCardMessage(program: string | null | undefined, result: { xErrorCode?: string; xError?: string; xCardType?: string }): string {
  const fund = program || 'fund';
  const err = result.xError ?? '';
  if (result.xErrorCode === '01298' || /invalid account setup/i.test(err)) {
    return `${fund} cards can't be used on this page right now. Please choose another way to pay, or contact the organization.`;
  }
  if (/cvv/i.test(err)) return `The ${fund} card's CVV wasn't accepted. Please check it${FUND_CVV[fund] ? ' (3 digits)' : ''} and try again.`;
  if (/exp/i.test(err)) return `The ${fund} card's expiry date wasn't accepted. Please check it and try again.`;
  if (/not supported for this card|invalid card/i.test(err)) return `That number isn't a ${fund} card. Please check the card number.`;
  if (/insufficient|balance|limit/i.test(err)) return `The ${fund} account doesn't have enough available for this gift.`;
  return `The ${fund} card wasn't accepted${err ? ` (${err})` : ''}. Please check the details or choose another way to pay.`;
}
