/** The stale-check threshold when the organization has none saved; the Task Sheet uses the same number. */
export const STALE_CHECK_DEFAULT = 90;

/** A whole number of days from 1 to 3650, or an error message. */
export function parseStaleDays(text: string): number | string {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return 'Enter a whole number of days.';
  const n = Number(t);
  if (n < 1 || n > 3650) return 'Enter a number of days from 1 to 3650.';
  return n;
}
