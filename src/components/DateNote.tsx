import { useEffect, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import { localToday } from '../lib/format';

/** Beneath a date field: says so when a coming date is Shabbos or Yom Tov. It never stops anyone using the date. */
export default function DateNote({ date }: { date: string | null | undefined }) {
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (!date || date < localToday()) return setNote(null);
    let live = true;
    // The calendar is large, so it loads only when a date needs checking.
    import('../lib/jewishCalendar').then(m => { if (live) setNote(m.dateWarning(date)); });
    return () => { live = false; };
  }, [date]);
  return note ? <span className="date-note" role="status"><TriangleAlert size={14} /> {note}. You can still use this date.</span> : null;
}
