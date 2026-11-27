import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CalendarClock, CalendarDays, CalendarRange, Clock, Handshake, TrendingUp } from 'lucide-react';
import DataTable from '../components/DataTable';
import Kpi from '../components/Kpi';
import { Balance, Pill } from '../components/Pill';
import { useAuth } from '../lib/auth';
import { addDays, money, orgTimeZone, orgToday } from '../lib/format';
import MethodPie, { type MethodTotal } from '../components/MethodPie';
import { fetchAll, supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';
import { ALL_TOPICS, useLiveRefresh } from '../lib/live';
import { useTaskCount } from './TaskSheet';

type Range = 'today' | 'yesterday' | 'week' | 'month' | 'year' | '30' | 'custom';
const RANGES: [Range, string][] = [['30', 'Last 30 days'], ['today', 'Today'], ['yesterday', 'Yesterday'], ['week', 'This week'], ['month', 'This month'], ['year', 'This year'], ['custom', 'Custom']];

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
/** The dates a range covers, counted in the organization's time zone like every other total (readiness #9: the
 *  dashboard used this computer's own date, so "Today" could be a different day than on Transactions). */
export function rangeDates(r: Range, from: string, to: string, now = new Date()): [string, string] {
  const today = orgToday(now);
  const back = (n: number) => addDays(today, -n);
  switch (r) {
    case 'today': return [today, today];
    case 'yesterday': return [back(1), back(1)];
    case 'week': return [back(new Date(`${today}T12:00:00Z`).getUTCDay()), today];
    case 'month': return [`${today.slice(0, 8)}01`, today];
    case 'year': return [`${today.slice(0, 5)}01-01`, today];
    case 'custom': return [from || back(30), to || today];
    default: return [back(29), today];
  }
}
const lastYear = (d: string) => `${Number(d.slice(0, 4)) - 1}${d.slice(4)}`;

const stats = async (from: string, to: string) => {
  const { data, error } = await supabase.rpc('dashboard_stats', { p_from: from, p_to: to });
  if (error) throw new Error(error.message);
  return data as Row;
};

/** One bar per day, including days with nothing, so gaps read as gaps. */
function DailyChart({ daily, from, to }: { daily: Row[]; from: string; to: string }) {
  const days = useMemo(() => {
    const byDay = new Map(daily.map(d => [d.day, Number(d.total)]));
    const out: { day: string; total: number }[] = [];
    const end = new Date(`${to}T12:00:00`);
    for (let d = new Date(`${from}T12:00:00`); d <= end && out.length < 400; d.setDate(d.getDate() + 1)) {
      const key = iso(d);
      out.push({ day: key, total: byDay.get(key) ?? 0 });
    }
    return out;
  }, [daily, from, to]);
  const [hover, setHover] = useState<{ day: string; total: number } | null>(null);
  const top = Math.max(0, ...days.map(d => d.total));
  const max = top || 1;
  return (
    <div className="chart">
      <div className="chart-readout">{hover ? <><b>{money(hover.total)}</b> on {hover.day}</> : <span className="muted">Hover a bar for that day's total</span>}</div>
      <div className="chart-bars" role="img" aria-label={`Daily donation totals from ${from} to ${to}`} onMouseLeave={() => setHover(null)}>
        {days.map(d => (
          <div
            className="chart-slot"
            key={d.day}
            title={`${d.day}: ${money(d.total)}`}
            onMouseEnter={() => setHover(d)}
            onClick={() => setHover(d)}
          >
            <div className="chart-bar" style={{ height: `${d.total ? Math.max((d.total / max) * 100, 1.5) : 0}%` }} />
          </div>
        ))}
      </div>
      <div className="chart-axis"><span>{days[0]?.day}</span><span>{top ? `${money(top)} peak` : 'No gifts in this period'}</span><span>{days[days.length - 1]?.day}</span></div>
    </div>
  );
}

const change = (now: number, then: number) => {
  if (!then) return now ? 'nothing the same period last year' : 'same as last year';
  const pct = Math.round(((now - then) / then) * 100);
  return `${pct >= 0 ? '+' : ''}${pct}% vs ${money(then)} last year`;
};

export default function DashboardPage() {
  const { isAdmin } = useAuth();
  const [range, setRange] = useState<Range>('30');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [compare, setCompare] = useState(false);
  const [from, to] = rangeDates(range, customFrom, customTo);
  const taskCount = useTaskCount(isAdmin, 'dashboard');

  const q = useQuery(() => stats(from, to), [from, to]);
  const prior = useQuery(() => (compare ? stats(lastYear(from), lastYear(to)) : Promise.resolve(null)), [compare, from, to]);
  // Upcoming recurring card and bank charges (Moshe Henig, 2026-11-11: the box takes its numbers from them, not from
  // recurring pledges): each active schedule's amount times its charges due in the next 30 and 90 days.
  const recurring = useQuery(async () => {
    const list = (await supabase.from('recurring_list').select('amount, due_30, due_90').eq('status', 'active')).data as Row[] ?? [];
    return {
      next30: list.reduce((t, r) => t + Number(r.amount) * Number(r.due_30 ?? 0), 0),
      next90: list.reduce((t, r) => t + Number(r.amount) * Number(r.due_90 ?? 0), 0),
      active: list.length,
    };
  }, []);
  const myTasks = useQuery(async () => (isAdmin ? [] : (await supabase.from('tasks').select('id, status, due_date').neq('status', 'Done')).data ?? []) as Row[], [isAdmin]);

  // Kept up to date (Moshe Henig, 2026-11-15: a dashboard left open since before new gifts came in looked wrong):
  // refreshed quietly every 2 minutes and whenever you come back to the tab, with the time it was last updated shown.
  const [updatedAt, setUpdatedAt] = useState(() => new Date());
  useEffect(() => { if (q.data) setUpdatedAt(new Date()); }, [q.data]);
  // Updates on its own when gifts, payouts, transfers, pledges or campaigns change (live refresh, Moshe Henig,
  // 2026-11-15); without a live connection, every 2 minutes while the tab is open.
  useLiveRefresh(ALL_TOPICS, () => { void q.reload({ quiet: true }); void recurring.reload({ quiet: true }); if (compare) void prior.reload({ quiet: true }); });

  // Any part missing reads as zero rather than breaking the page.
  const s = q.data as Row | undefined;
  const per = (k: string) => (s?.periods as Row | undefined)?.[k] as Row | undefined;
  const period = (p?: Row) => (p ? `${money(p.fees)} fees · ${money(Number(p.raised) - Number(p.fees))} net` : '');
  // Until the first numbers arrive, a placeholder rather than $0.00, which reads as a real zero.
  const amt = (v: unknown) => (s ? money(v as number) : '…');
  const tasksOpen = (myTasks.data as Row[]) ?? [];
  const today = orgToday();

  return (
    <section className="view">
      <div className="view-head"><div className="view-title"><h1>Dashboard</h1>
        <span className="count">Updated {updatedAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: orgTimeZone() })} · updates live</span></div></div>
      {q.error && <div className="error">{q.error}</div>}

      <div className="kpis">
        <Kpi label="Today" value={amt(per('today')?.raised ?? 0)} icon={<Clock size={16} />} tone="green" sub={period(per('today'))} />
        {/* All Time in place of This Week (Moshe Henig, 2026-11-11). */}
        <Kpi label="All time" value={amt(per('all')?.raised ?? 0)} icon={<CalendarDays size={16} />} tone="green" sub={period(per('all'))} />
        <Kpi label="This month" value={amt(per('month')?.raised ?? 0)} icon={<CalendarRange size={16} />} tone="green" sub={period(per('month'))} />
        {isAdmin && <Kpi label="This year" value={amt(per('year')?.raised ?? 0)} icon={<TrendingUp size={16} />} tone="green" sub={period(per('year'))} />}
        {/* Checks not delivered yet sit with open pledges: promised, not raised (Moshe Henig, #8). */}
        <Kpi label="Pledged & checks not delivered" value={amt(Number(s?.pledged ?? 0) + Number(s?.undelivered?.amount ?? 0))} icon={<Handshake size={16} />} tone="blue"
          sub={`${money(s?.pledged ?? 0)} open pledges · ${money(s?.undelivered?.amount ?? 0)} in ${s?.undelivered?.count ?? 0} check${Number(s?.undelivered?.count) === 1 ? '' : 's'} not delivered · not in raised`} />
        <Kpi label="Recurring transactions" value={<Link to="/donations/recurring">{money(recurring.data?.next30 ?? 0)}</Link>} icon={<CalendarClock size={16} />} tone="violet"
          sub={`next 30 days · ${money(recurring.data?.next90 ?? 0)} next 90 · ${recurring.data?.active ?? 0} active`} />
        {isAdmin && <Kpi label="Tasks waiting" value={<Link to="/task-sheet">{taskCount}</Link>} icon={<AlertTriangle size={16} />} tone="amber" sub="On the Task Sheet" />}
        {!isAdmin && <Kpi label="My tasks" value={<Link to="/tasks">{tasksOpen.length}</Link>} icon={<AlertTriangle size={16} />} tone="amber" sub={`${tasksOpen.filter(t => t.due_date && t.due_date < today).length} overdue`} />}
      </div>

      {isAdmin && <BooksHealth />}

      <details className="dash-defs">
        <summary>How these numbers are calculated</summary>
        <ul>
          <li><b>Raised</b> (Today, This month, This year, All time, the chart and the pie): successful gifts by the day they came in, New York time. A batch deposit counts what has been funded so far. Voided, refunded, failed and to-collect gifts, and checks not delivered yet, aren't counted. The Transactions totals and campaign balances use the same rule.</li>
          <li><b>Fees</b> and <b>net</b>: the fees on those same gifts, and raised minus fees.</li>
          <li><b>Pledged & checks not delivered</b>: what's still owed on open pledges, plus checks recorded but not delivered yet. Promised money, not counted in raised.</li>
          <li><b>Recurring transactions</b>: what active recurring gifts are scheduled to charge in the next 30 and 90 days.</li>
          <li>Fundraisers see these numbers for their own campaigns.</li>
        </ul>
      </details>

      {!isAdmin && (
        <div className="quick-links">
          <Link className="btn" to="/donors">Look up a donor</Link>
          <Link className="btn" to="/donors">Add a donor</Link>
          <Link className="btn" to="/donations/pledges">Add a pledge</Link>
        </div>
      )}

      <div className="filter-bar">
        <select aria-label="Period" value={range} onChange={e => setRange(e.target.value as Range)}>
          {RANGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        {range === 'custom' && (
          <>
            <input type="date" aria-label="From" value={customFrom} onChange={e => setCustomFrom(e.target.value)} />
            <input type="date" aria-label="To" value={customTo} onChange={e => setCustomTo(e.target.value)} />
          </>
        )}
        <label className="inline-check"><input type="checkbox" checked={compare} onChange={e => setCompare(e.target.checked)} /> Compare to last year</label>
      </div>

      {/* Donations over time, with the pie of payment methods beside it (Moshe Henig, 2026-11-11). */}
      <div className="dash-row">
      <div className="card">
        <h3>Donations over time</h3>
        <p className="range-total">
          <b>{money(s?.range?.raised ?? 0)}</b> raised · {money(s?.range?.fees ?? 0)} fees · {money(Number(s?.range?.raised ?? 0) - Number(s?.range?.fees ?? 0))} net · {s?.range?.count ?? 0} gifts
          {compare && prior.data && <span className="muted"> · {change(Number(s?.range?.raised ?? 0), Number((prior.data as Row).range?.raised))}</span>}
        </p>
        <DailyChart daily={s?.daily ?? []} from={from} to={to} />
      </div>
      <MethodPie methods={(s?.methods as MethodTotal[] | undefined) ?? []} />
      </div>

    </section>
  );
}

/** Every fundraiser's money at a glance, so one negative campaign is seen against the whole. */
export function BalanceSummaryPage() {
  const [negativeOnly, setNegativeOnly] = useState(false);
  const [activeOnly, setActiveOnly] = useState(false);
  const q = useQuery(async () => {
    const [c, m] = await Promise.all([
      fetchAll((a, b) => supabase.from('campaign_summary').select('id, internal_name, manager_id, status, balance, balance_mode').order('id').range(a, b) as never),
      fetchAll((a, b) => supabase.from('managers').select('id, full_name, status').order('full_name').range(a, b) as never),
    ]);
    return { campaigns: c as Row[], managers: m as Row[] };
  }, []);
  const [open, setOpen] = useState<Set<string>>(new Set());
  useEffect(() => { setOpen(new Set()); }, [negativeOnly, activeOnly]);

  const rows = useMemo(() => (q.data?.managers ?? []).map(m => {
    const mine = (q.data?.campaigns ?? []).filter(c => c.manager_id === m.id && c.balance_mode !== 'shared');
    return {
      id: m.id, name: m.full_name, status: m.status,
      total: mine.reduce((s, c) => s + Number(c.balance), 0),
      active: mine.filter(c => c.status === 'active').length,
      count: mine.length,
      negatives: mine.filter(c => Number(c.balance) < 0).length,
      breakdown: mine.map(c => `${c.id}: ${money(c.balance)}`).join(' · '),
      campaigns: mine,
    };
  }).filter(r => r.count > 0)
    .filter(r => !negativeOnly || r.negatives > 0)
    .filter(r => !activeOnly || r.status === 'active')
  , [q.data, negativeOnly, activeOnly]);

  return (
    <section className="view">
      <DataTable
        title="Balance Summary"
        rows={rows}
        loading={q.loading}
        error={q.error}
        exportName="fundraiser-balance-summary"
        initialSort={{ key: 'total', dir: 'desc' }}
        onOpen={r => setOpen(o => {
          const n = new Set(o);
          if (n.has(r.id)) n.delete(r.id); else n.add(r.id);
          return n;
        })}
        columns={[
          {
            key: 'name', label: 'Fundraiser', width: 260,
            render: r => (
              <>
                {r.name}
                {open.has(r.id) && (
                  <ul className="plain balance-list">
                    {(r.campaigns as Row[]).map(c => (
                      <li key={c.id}>
                        <Link to={`/campaigns/${encodeURIComponent(c.id)}`} onClick={e => e.stopPropagation()}>{c.id} {c.internal_name}</Link>: <Balance value={c.balance} />
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ),
          },
          { key: 'total', label: 'Total balance', render: r => <Balance value={r.total} />, align: 'right' },
          { key: 'count', label: 'Campaigns', align: 'right' },
          { key: 'active', label: 'Active', align: 'right' },
          { key: 'negatives', label: 'Negative', render: r => (r.negatives > 0 ? <Pill tone="red">{r.negatives} below zero</Pill> : ''), value: r => r.negatives, align: 'right' },
          { key: 'breakdown', label: 'By campaign', width: 320 },
        ]}
        actions={
          <>
            <label className="inline-check"><input type="checkbox" checked={negativeOnly} onChange={e => setNegativeOnly(e.target.checked)} /> Only with negative campaigns</label>
            <label className="inline-check"><input type="checkbox" checked={activeOnly} onChange={e => setActiveOnly(e.target.checked)} /> Only active fundraisers</label>
          </>
        }
      />
    </section>
  );
}

/**
 * Books health (readiness #26): the latest nightly check of the books, green when every check came back clean,
 * red with what it found (each also on the Task Sheet). Admins only; "Check now" runs it again.
 */
function BooksHealth() {
  const [busy, setBusy] = useState(false);
  const q = useQuery(async () => ((await supabase.from('integrity_runs').select('ran_at, ok, results').order('ran_at', { ascending: false }).limit(1)).data ?? [])[0] as Row | undefined, []);
  const run = q.data;
  const found = ((run?.results ?? []) as Row[]).filter(r => Number(r.n) > 0);
  async function now() {
    setBusy(true);
    await supabase.rpc('check_books_now');
    setBusy(false);
    void q.reload({ quiet: true });
    window.dispatchEvent(new Event('task-sheet-changed'));
  }
  return (
    <div className={`books-health ${run ? (run.ok ? 'ok' : 'bad') : ''}`} role="status">
      <b>Books health: {run ? (run.ok ? 'all checks clean' : `${found.length} check${found.length === 1 ? '' : 's'} need a look`) : 'not checked yet'}</b>
      {run && <span className="muted small"> · checked {new Date(run.ran_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: orgTimeZone() })}</span>}
      {found.length > 0 && <span className="small"> · {found.map(r => `${r.label} (${r.n})`).join(' · ')} · <Link to="/task-sheet">on the Task Sheet</Link></span>}
      <button type="button" className="link small" disabled={busy} onClick={now}>{busy ? 'Checking…' : 'Check now'}</button>
    </div>
  );
}
