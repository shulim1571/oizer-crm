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

/** The number new campaigns start at (Moshe Henig, 2026-11-15): a whole number from 1 to 999,999,999,999. */
export const CAMPAIGN_ID_START_DEFAULT = 1000;
export function parseCampaignIdStart(text: string): number | string {
  const t = text.trim();
  if (!/^\d{1,12}$/.test(t) || Number(t) < 1) return 'Enter a whole number, 1 or more.';
  return Number(t);
}
