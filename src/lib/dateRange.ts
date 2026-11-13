/**
 * Date range for lists (Moshe Henig, 2026-11-11: replaces the Last 7 Days tab on Transactions). Saved in the list's
 * view settings by preset, so "Last 30 days" keeps rolling forward and "Save as my default" keeps each person's
 * choice. Days are counted in this computer's time zone, from the start of the first day.
 */
export type RangePreset = 'all' | '7' | '30' | '60' | '365' | 'custom';
export interface DateRange { preset: RangePreset; from?: string; to?: string }   // from/to: YYYY-MM-DD, custom only

export const RANGE_PRESETS: { value: RangePreset; label: string }[] = [
  { value: 'all', label: 'All time' },
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '60', label: 'Last 60 days' },
  { value: '365', label: 'Last year' },
  { value: 'custom', label: 'Custom range…' },
];

const startOfLocalDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const parseDay = (s?: string) => {
  const m = s?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
};

/** The instants a range covers: from (inclusive) and to (exclusive), as ISO strings; either may be open. */
export function rangeBounds(range: DateRange | undefined, now = new Date()): { from?: string; to?: string } {
  if (!range || range.preset === 'all') return {};
  if (range.preset === 'custom') {
    const from = parseDay(range.from);
    const to = parseDay(range.to);
    return {
      ...(from ? { from: from.toISOString() } : {}),
      ...(to ? { to: new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1).toISOString() } : {}),
    };
  }
  const days = Number(range.preset);
  const today = startOfLocalDay(now);
  // "Last 7 days" is today and the 6 days before it.
  return { from: new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1)).toISOString() };
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

/** A local date `offset` days from today, as YYYY-MM-DD (for custom range starting values). */
export function dayOffset(offset = 0, now = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
