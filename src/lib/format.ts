const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
let timeZone = 'America/New_York';
const dateFormat = () => new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'short', day: 'numeric' });
const timeFormat = () => new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' });
let d = dateFormat();
let t = timeFormat();

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
