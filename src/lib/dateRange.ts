/**
 * Date range for lists (Moshe Henig, 2026-11-11: replaces the Last 7 Days tab on Transactions). Saved in the list's
 * view settings by preset, so "Last 30 days" keeps rolling forward and "Save as my default" keeps each person's
 * choice. Days are counted in the organization's time zone (Moshe Henig, 2026-11-15: they were counted in this
 * computer's zone, so a computer set to another zone cut the days at the wrong hour), from the start of the first day.
 */
import { addDays, orgDayStart, orgToday } from './format';
export type RangePreset = 'all' | 'today' | '7' | '30' | '60' | '365' | 'custom';
export interface DateRange { preset: RangePreset; from?: string; to?: string }   // from/to: YYYY-MM-DD, custom only

export const RANGE_PRESETS: { value: RangePreset; label: string }[] = [
  { value: 'all', label: 'All time' },
  { value: 'today', label: 'Today' },   // Moshe Henig, 2026-11-15
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '60', label: 'Last 60 days' },
  { value: '365', label: 'Last year' },
  { value: 'custom', label: 'Custom range…' },
];

const isDay = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** The instants a range covers: from (inclusive) and to (exclusive), as ISO strings; either may be open. */
export function rangeBounds(range: DateRange | undefined, now = new Date()): { from?: string; to?: string } {
  if (!range || range.preset === 'all') return {};
  if (range.preset === 'custom') {
    return {
      ...(isDay(range.from) ? { from: orgDayStart(range.from!) } : {}),
      ...(isDay(range.to) ? { to: orgDayStart(addDays(range.to!, 1)) } : {}),
    };
  }
  const today = orgToday(now);
  // Today: from the start of today, until the start of tomorrow.
  if (range.preset === 'today') return { from: orgDayStart(today), to: orgDayStart(addDays(today, 1)) };
  const days = Number(range.preset);
  if (!Number.isFinite(days) || days < 1) return {};   // an unknown saved preset shows everything
  // "Last 7 days" is today and the 6 days before it.
  return { from: orgDayStart(addDays(today, -(days - 1))) };
}

export const inRange = (value: unknown, b: { from?: string; to?: string }) => {
  if (!b.from && !b.to) return true;
  if (value == null || value === '') return false;
  const t = new Date(String(value)).getTime();
  if (Number.isNaN(t)) return false;
  return (!b.from || t >= new Date(b.from).getTime()) && (!b.to || t < new Date(b.to).getTime());
};

export const rangeLabel = (r: DateRange | undefined) =>
  !r ? 'All time' : r.preset === 'custom' ? `${r.from ?? '…'} to ${r.to ?? '…'}` : RANGE_PRESETS.find(p => p.value === r.preset)?.label ?? 'All time';

/** A date `offset` days from today in the organization's time zone, as YYYY-MM-DD (for custom range starting values). */
export function dayOffset(offset = 0, now = new Date()): string {
  return addDays(orgToday(now), offset);
}
