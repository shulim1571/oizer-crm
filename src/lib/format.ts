const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const dt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric', month: 'numeric', day: 'numeric',
  hour: 'numeric', minute: '2-digit', second: '2-digit',
});
const d = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: 'numeric', day: 'numeric' });

export const money = (v: unknown) => (v == null || v === '' ? '' : usd.format(Number(v)));
export const pct = (v: unknown) => (v == null ? '' : `${(Number(v) * 100).toFixed(2)}%`);
export const dateTime = (v: unknown) => (v ? dt.format(new Date(String(v))) : '');
export const date = (v: unknown) => (v ? d.format(new Date(String(v))) : '');
export const yn = (v: unknown) => (v === true ? 'Y' : v === false ? 'N' : '');

/** Value for <input type="datetime-local"> in Eastern time. */
export function toLocalInput(v: unknown): string {
  const when = v ? new Date(String(v)) : new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(when);
  const p = (t: string) => parts.find(x => x.type === t)?.value ?? '';
  return `${p('year')}-${p('month')}-${p('day')}T${p('hour')}:${p('minute')}`;
}

/** Convert an Eastern datetime-local string back to an ISO timestamp. */
export function fromLocalInput(v: string): string {
  const guess = new Date(`${v}:00Z`);
  const eastern = new Date(guess.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const utc = new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' }));
  return new Date(guess.getTime() + (utc.getTime() - eastern.getTime())).toISOString();
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
