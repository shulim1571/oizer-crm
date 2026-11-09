import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Plus, X } from 'lucide-react';
import { dateTime, localToday, money } from '../lib/format';
import { dateOf, isoOf, jewishDays, type JewishDay } from '../lib/jewishCalendar';
import { fetchAll, supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';
import { Overlay } from './Pledges';
import { BookingActions, BookingPill, RequestForm } from './Machines';

const WEEK_HEAD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Shabbos'];
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const startOfWeek = (d: Date) => addDays(d, -d.getDay());

export default function CalendarPage() {
  const [mode, setMode] = useState<'month' | 'week'>('month');
  const [anchor, setAnchor] = useState(() => dateOf(localToday()));
  const [open, setOpen] = useState<JewishDay | null>(null);
  const [version, setVersion] = useState(0);

  const [start, end] = useMemo(() => {
    if (mode === 'week') { const s = startOfWeek(anchor); return [s, addDays(s, 6)]; }
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
    return [startOfWeek(first), addDays(startOfWeek(last), 6)];
  }, [mode, anchor]);
  const days = useMemo(() => jewishDays(start, end), [start, end]);
  const from = isoOf(start);
  const to = isoOf(end);

  const data = useQuery(async () => {
    const [list, avail, payouts] = await Promise.all([
      fetchAll((a, b) => supabase.from('machine_booking_list').select('*').gte('booking_date', from).lte('booking_date', to).neq('status', 'cancelled').order('queue_at').range(a, b) as never),
      supabase.rpc('machine_availability', { p_from: from, p_to: to }),
      supabase.from('expenses').select('id, amount, payee, method, scheduled_for, campaign_id').is('processed_at', null).gte('scheduled_for', from).lte('scheduled_for', to).order('scheduled_for'),
    ]);
    if (avail.error) throw new Error(avail.error.message);
    return { list: list as Row[], machines: (avail.data as Row[])[0]?.machines ?? 0, payouts: (payouts.data ?? []) as Row[] };
  }, [from, to, version]);
  const machines = data.data?.machines ?? 0;
  const byDay = useMemo(() => {
    const m = new Map<string, Row[]>();
    for (const b of data.data?.list ?? []) m.set(b.booking_date, [...(m.get(b.booking_date) ?? []), b]);
    return m;
  }, [data.data]);
  const payoutsByDay = useMemo(() => {
    const m = new Map<string, Row[]>();
    for (const p of data.data?.payouts ?? []) m.set(p.scheduled_for, [...(m.get(p.scheduled_for) ?? []), p]);
    return m;
  }, [data.data]);

  const move = (n: number) => setAnchor(a => (mode === 'week' ? addDays(a, n * 7) : new Date(a.getFullYear(), a.getMonth() + n, 1)));
  const title = mode === 'week'
    ? `${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`
    : anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const inView = days.filter(d => mode === 'week' || dateOf(d.iso).getMonth() === anchor.getMonth());
  const hebrewTitle = [...new Set(inView.flatMap(d => [d.hebrewEnglish.replace(/^\d+\w+ of /, '')]))];
  const today = localToday();

  return (
    <section className="view">
      <div className="calendar-head">
        <button type="button" className="icon-btn outlined" title="Previous" onClick={() => move(-1)}><ChevronLeft size={17} /></button>
        <button type="button" className="icon-btn outlined" title="Next" onClick={() => move(1)}><ChevronRight size={17} /></button>
        <button type="button" className="btn" onClick={() => setAnchor(dateOf(today))}>Today</button>
        <div className="calendar-title"><h2>{title}</h2><span className="muted small">{hebrewTitle.join(' – ')}</span></div>
        <div className="spacer" />
        <div className="tabs compact">
          <button className={mode === 'month' ? 'active' : ''} onClick={() => setMode('month')}>Month</button>
          <button className={mode === 'week' ? 'active' : ''} onClick={() => setMode('week')}>Week</button>
        </div>
      </div>
      {data.error && <div className="error">{data.error}</div>}
      <div className={`calendar ${mode}`}>
        {WEEK_HEAD.map(w => <div key={w} className="calendar-weekday"><span className="long">{w}</span><span className="short">{w.slice(0, 3)}</span></div>)}
        {days.map(d => {
          const bookings = byDay.get(d.iso) ?? [];
          const over = bookings.length > machines && bookings.length > 0;
          const faded = mode === 'month' && dateOf(d.iso).getMonth() !== anchor.getMonth();
          return (
            <button
              type="button"
              key={d.iso}
              className={`calendar-day${d.shabbos ? ' shabbos' : ''}${d.yomTov ? ' yomtov' : ''}${d.cholHamoed ? ' cholhamoed' : ''}${faded ? ' faded' : ''}${d.iso === today ? ' today' : ''}${over ? ' over' : ''}`}
              onClick={() => setOpen(d)}
            >
              <span className="calendar-dates"><b>{d.day}</b><span className="hebrew" title={d.hebrewEnglish}>{d.hebrew}</span></span>
              {d.parsha && <span className="calendar-line">{d.parsha}</span>}
              {d.holidays.map(h => <span key={h} className="calendar-line holiday">{h}</span>)}
              {d.candles && <span className="calendar-line muted">Candles {d.candles}</span>}
              {d.havdalah && <span className="calendar-line muted">Ends {d.havdalah}</span>}
              {(payoutsByDay.get(d.iso) ?? []).length > 0 && (
                <span className="calendar-line payout">{(payoutsByDay.get(d.iso) ?? []).length === 1 ? 'Payout' : `${(payoutsByDay.get(d.iso) ?? []).length} payouts`} {money((payoutsByDay.get(d.iso) ?? []).reduce((s, p) => s + Number(p.amount), 0))}</span>
              )}
              {mode === 'month' && bookings.slice(0, 2).map(b => (
                <span key={b.id} className={`calendar-line booking ${b.status}`} title={`${b.fundraiser ?? 'No fundraiser'} · ${b.campaign_name} - ${b.campaign_id} · ${b.status}`}>
                  {b.machine_nickname ? `#${b.machine_nickname} ` : ''}{b.fundraiser ?? b.campaign_name}
                </span>
              ))}
              {mode === 'month' && bookings.length > 2 && <span className="calendar-line muted">+{bookings.length - 2} more</span>}
              {mode === 'week' && bookings.map(b => (
                <span key={b.id} className={`calendar-line booking ${b.status}`}>{b.machine_nickname ? `#${b.machine_nickname} ` : ''}{b.fundraiser ?? 'No fundraiser'} · {b.campaign_id}</span>
              ))}
              {bookings.length > 0 && (
                <span className={`calendar-count${over ? ' over' : ''}`}>{bookings.length} of {machines} machines{over ? ' · Over Capacity' : ''}</span>
              )}
            </button>
          );
        })}
      </div>
      <p className="muted small">Machine bookings show on their day; click a day to confirm, move or cancel them. Shabbos and Yom Tov are shaded. Times are for New York. Scheduled payouts show on the day they're due.</p>
      {open && <DayDialog day={open} machines={machines} bookings={byDay.get(open.iso) ?? []} payouts={payoutsByDay.get(open.iso) ?? []} onClose={() => setOpen(null)} onChanged={() => setVersion(v => v + 1)} />}
    </section>
  );
}

function DayDialog({ day, machines, bookings, payouts, onClose, onChanged }: { day: JewishDay; machines: number; bookings: Row[]; payouts: Row[]; onClose: () => void; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [adding, setAdding] = useState(false);
  useEffect(() => { setError(null); setAdding(false); }, [day.iso]);
  const past = day.iso < localToday();
  async function act(call: PromiseLike<{ error: { message: string } | null }>) {
    setError(null);
    const { error: e } = await call;
    if (e) return setError(e.message);
    setVersion(v => v + 1);
    onChanged();
    window.dispatchEvent(new Event('task-sheet-changed'));
  }
  const confirmed = bookings.filter(b => b.status === 'confirmed').length;
  return (
    <Overlay onClose={onClose}>
      <div className="form-head">
        <h2>{dateOf(day.iso).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</h2>
        <button type="button" className="icon-btn" title="Close" onClick={onClose}><X size={18} /></button>
      </div>
      <p className="muted"><span className="hebrew">{day.hebrew}</span> · {day.hebrewEnglish}</p>
      {(day.shabbos || day.holidays.length > 0 || day.candles) && (
        <p>
          {[day.shabbos && (day.parsha ?? 'Shabbos'), ...day.holidays, day.candles && `Candle lighting ${day.candles}`, day.havdalah && `Ends ${day.havdalah}`].filter(Boolean).join(' · ')}
        </p>
      )}
      {payouts.length > 0 && (
        <>
          <h3>Scheduled payouts</h3>
          <ul className="plain">
            {payouts.map(p => <li key={p.id}><b>{money(p.amount)}</b> {p.method} to {p.payee ?? 'no payee'} · campaign {p.campaign_id}</li>)}
          </ul>
        </>
      )}
      <h3>Machine requests</h3>
      <p className="muted small">{bookings.length} request{bookings.length === 1 ? '' : 's'} · {confirmed} confirmed · {machines} machine{machines === 1 ? '' : 's'} in service{bookings.length > machines ? ' · Over Capacity' : ''}</p>
      {error && <div className="error">{error}</div>}
      {bookings.map(b => (
        <div key={b.id} className="panel-box">
          <div className="booking-row">
            <b>{b.queue_position}.</b> {b.fundraiser ?? 'No fundraiser'} · {b.campaign_name} - {b.campaign_id} <BookingPill status={b.status} />
            {b.machine_nickname != null && <b> Machine {b.machine_nickname}</b>}
          </div>
          <div className="muted small">
            Requested {dateTime(b.requested_at)}{b.notes ? ` · ${b.notes}` : ''}{b.offered_at && b.status === 'pending' ? ' · A machine opened up' : ''}{b.priority_note ? ` · Moved: ${b.priority_note}` : ''}
          </div>
          {!past && <BookingActions booking={b} onAct={call => act(call)} version={version} />}
        </div>
      ))}
      {bookings.length === 0 && <p className="muted">No requests for this day.</p>}
      {!past && (adding
        ? <RequestForm initialDate={day.iso} title="Add a booking for this day" onDone={() => { setVersion(v => v + 1); onChanged(); window.dispatchEvent(new Event('task-sheet-changed')); }} />
        : <div className="form-actions"><div className="spacer" /><button type="button" className="btn primary" onClick={() => setAdding(true)}><Plus size={16} /> Add a booking for this day</button></div>)}
    </Overlay>
  );
}
