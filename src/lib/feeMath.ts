/**
 * A fee rounded DOWN to the cent, never up (Moshe Henig, 2026-11-15), matching the database's trunc(fee, 2).
 * Floating-point arithmetic can land a hair under a whole cent (0.29 * 100 is 28.999999999999996), so a tiny
 * allowance keeps an exact cent from being cut to the one below.
 */
export function feeDown(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const cents = value >= 0 ? Math.floor(value * 100 + 1e-7) : Math.ceil(value * 100 - 1e-7);
  return cents / 100;
}
