// Dates in a recurring schedule, matching public.recurring_date on the server (Postgres month arithmetic:
// adding a month to the 31st lands on the last day of a shorter month).

/** The next date after `iso`: a week, a month, three months or a year on. */
export function nextDate(iso: string, frequency: string) {
  const [y, m, d] = iso.split('-').map(Number);
  if (frequency === 'weekly') return new Date(Date.UTC(y, m - 1, d + 7)).toISOString().slice(0, 10);
  const months = frequency === 'quarterly' ? 3 : frequency === 'annually' ? 12 : 1;
  const last = new Date(Date.UTC(y, m - 1 + months + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + months, Math.min(d, last))).toISOString().slice(0, 10);
}
