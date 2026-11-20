const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
let timeZone = 'America/New_York';
const dateFormat = () => new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'short', day: 'numeric' });
const timeFormat = () => new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' });
let d = dateFormat();
let t = timeFormat();

/** The organization's time zone (IANA name), for showing clock times. */
export const orgTimeZone = () => timeZone;

/** Dates display in the organization's time zone. */
export function setTimezone(zone: string) {
  timeZone = zone;
  d = dateFormat();
  t = timeFormat();
}

export const money = (v: unknown) => (v == null || v === '' ? '' : usd.format(Number(v)));
export const pct = (v: unknown) => (v == null ? '' : `${(Number(v) * 100).toFixed(2)}%`);
/** Always the date and time together, e.g. "Jul 1, 2026 · 2:41 PM". */
export const dateTime = (v: unknown) => {
  if (!v) return '';
  const when = new Date(String(v));
  return `${d.format(when)} · ${t.format(when)}`;
};
export const yn = (v: unknown) => (v === true ? 'Y' : v === false ? 'N' : '');

/** Value for <input type="datetime-local"> in the organization's time zone. */
export function toLocalInput(v: unknown): string {
  const when = v ? new Date(String(v)) : new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(when);
  const p = (t: string) => parts.find(x => x.type === t)?.value ?? '';
  return `${p('year')}-${p('month')}-${p('day')}T${p('hour')}:${p('minute')}`;
}

/** Convert a datetime-local string in the organization's time zone back to an ISO timestamp. */
export function fromLocalInput(v: string): string {
  const guess = new Date(`${v}:00Z`);
  const local = new Date(guess.toLocaleString('en-US', { timeZone }));
  const utc = new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' }));
  return new Date(guess.getTime() + (utc.getTime() - local.getTime())).toISOString();
}

/** Today's date in the organization's time zone, as YYYY-MM-DD (Moshe Henig, 2026-11-15). */
export function orgToday(now = new Date()): string {
  return toLocalInput(now).slice(0, 10);
}
/** The instant a YYYY-MM-DD day starts in the organization's time zone, as an ISO string. */
export function orgDayStart(ymd: string): string {
  return fromLocalInput(`${ymd}T00:00`);
}
/** A YYYY-MM-DD date moved by whole days (calendar arithmetic, no time zone involved). */
export function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

export function toCsv(rows: Record<string, unknown>[], cols: { key: string; label: string }[]): string {
  const esc = (v: unknown) => {
    const t = v == null ? '' : String(v);
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  return [cols.map(c => esc(c.label)).join(','), ...rows.map(r => cols.map(c => esc(r[c.key])).join(','))].join('\n');
}

export function download(name: string, text: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

export const balanceClass = (v: unknown) => (Number(v) < 0 ? 'neg' : Number(v) > 0 ? 'pos' : '');

/** Today on this computer. toISOString() gives the UTC date, which is already tomorrow on a New York evening. */
export function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** One US number with dashes; anything else as it was. */
function formatOnePhone(raw: string): string {
  const m = raw.match(/^(.*?)(?:\s*(?:x|ext\.?|extension|#)\s*(\d{1,6}))?$/i);
  const main = m?.[1] ?? raw;
  const ext = m?.[2] ? ` x${m[2]}` : '';
  let d = main.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}${ext}`;
  if (d.length === 7) return `${d.slice(0, 3)}-${d.slice(3)}${ext}`;
  return raw;
}

// A US number inside other text: optional +1, area code (with or without brackets), then 3 and 4 digits with
// spaces, dots or dashes or nothing between, and an optional extension.
const US_PHONE = /(?<![\d+])(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?:\s*(?:x|ext\.?|extension)\s*\d{1,6})?(?!\d)/gi;

/**
 * Phone numbers with dashes, easier to read (Moshe Henig, 2026-11-16): 845-555-1234. Every US number in the text
 * gets them, so a field holding two numbers ("8455551234 / 718 555 9876", "Home (845) 555-1234, cell 718.555.9876")
 * shows both that way, with the words and separators around them kept. A leading 1 is dropped and an extension kept
 * (845-555-1234 x12); 7 digits alone read 555-1234; a number from abroad is shown as it was typed. Display only:
 * what's stored and what's dialed or texted stay as they are.
 */
export function formatPhone(p: unknown): string {
  const raw = String(p ?? '').trim();
  if (!raw) return '';
  if (raw.startsWith('+') && !raw.startsWith('+1')) return raw;
  // Two numbers run together with nothing between them (20 or 21 digits).
  const digits = raw.replace(/\D/g, '');
  if (/^\d+$/.test(raw.replace(/[.()-]/g, '')) && (digits.length === 20 || (digits.length === 22 && digits.startsWith('1')))) {
    const half = digits.length / 2;
    return `${formatOnePhone(digits.slice(0, half))} · ${formatOnePhone(digits.slice(half))}`;
  }
  const out = raw.replace(US_PHONE, m => formatOnePhone(m));
  return out === raw ? formatOnePhone(raw) : out;
}
