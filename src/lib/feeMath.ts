/**
 * A processing fee rounded UP to the cent, so the net (amount minus fee) rounds down (Moshe Henig, 2026-11-15),
 * matching the database's fee_up. Floating-point arithmetic can land a hair over a whole cent (0.07 * 100 is
 * 7.000000000000001), so a tiny allowance keeps an exact cent from being pushed to the next one.
 */
export function feeUp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.ceil(value * 100 - 1e-7) / 100 || 0;   // || 0 turns -0 into 0
}
