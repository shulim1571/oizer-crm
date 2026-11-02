import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CalendarClock, CalendarDays, CalendarRange, Clock, Handshake, Target, TrendingUp } from 'lucide-react';
import DataTable from '../components/DataTable';
import Kpi from '../components/Kpi';
import { Balance, Pill } from '../components/Pill';
import { useAuth } from '../lib/auth';
import { dateTime, money } from '../lib/format';
import { fetchAll, supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';
import { donorName } from './donationColumns';
import { useTaskCount } from './TaskSheet';

type Range = 'today' | 'yesterday' | 'week' | 'month' | 'year' | '30' | 'custom';
const RANGES: [Range, string][] = [['30', 'Last 30 days'], ['today', 'Today'], ['yesterday', 'Yesterday'], ['week', 'This week'], ['month', 'This month'], ['year', 'This year'], ['custom', 'Custom']];

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function rangeDates(r: Range, from: string, to: string): [string, string] {
  const now = new Date();
  const today = iso(now);
  const back = (n: number) => iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() - n));
  switch (r) {
    case 'today': return [today, today];
    case 'yesterday': return [back(1), back(1)];
    case 'week': return [back(now.getDay()), today];
    case 'month': return [iso(new Date(now.getFullYear(), now.getMonth(), 1)), today];
    case 'year': return [iso(new Date(now.getFullYear(), 0, 1)), today];
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
  const max = Math.max(...days.map(d => d.total), 1);
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
      <div className="chart-axis"><span>{days[0]?.day}</span><span>{money(max)} peak</span><span>{days[days.length - 1]?.day}</span></div>
    </div>
  );
}

function Ranked({ title, rows, to }: { title: string; rows: Row[]; to?: (r: Row) => string }) {
  const max = Math.max(...rows.map(r => Number(r.total)), 1);
  return (
    <div className="card">
      <h3>{title}</h3>
      <table className="mini"><tbody>
        {rows.map(r => (
          <tr key={r.id ?? r.name}>
            <td>
              {to ? <Link to={to(r)}>{r.name}</Link> : r.name}
              <div className="bar"><span style={{ width: `${(Number(r.total) / max) * 100}%` }} /></div>
            </td>
            <td className="right num">{money(r.total)}</td>
          </tr>
        ))}
        {rows.length === 0 && <tr><td className="muted">Nothing in this period</td></tr>}
      </tbody></table>
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
  const recent = useQuery(
    async () => (await supabase.from('donations').select('id, amount, created_at, payment_method, name, donor_label, anonymous, donors(display_name), campaigns(internal_name)')
      .eq('status', 'completed').order('created_at', { ascending: false }).limit(12)).data ?? [],
    [],
  );
  const campaigns = useQuery(
    () => fetchAll((a, b) => supabase.from('campaign_summary').select('id, internal_name, status, goal, combined_raised, balance, balance_mode, pledged_open').eq('status', 'active').order('internal_name').range(a, b) as never),
    [],
  );
  const overdue = useQuery(
    async () => (await supabase.from('pledge_list').select('id, campaign_id, campaign_internal, balance').eq('status', 'overdue')).data ?? [],
    [],
  );
  const myTasks = useQuery(async () => (isAdmin ? [] : (await supabase.from('tasks').select('id, status, due_date').neq('status', 'Done')).data ?? []) as Row[], [isAdmin]);

  const s = q.data;
  const list = (campaigns.data as Row[]) ?? [];
  const nearGoal = list.filter(c => Number(c.goal) > 0 && Number(c.combined_raised) >= Number(c.goal) * 0.9 && Number(c.combined_raised) < Number(c.goal));
  const overdueByCampaign = [...((overdue.data as Row[]) ?? []).reduce((m, p) => {
    const e = m.get(p.campaign_id) ?? { id: p.campaign_id, name: p.campaign_internal, total: 0 };
    e.total += Number(p.balance);
    return m.set(p.campaign_id, e);
  }, new Map<string, Row>()).values()].sort((a, b) => b.total - a.total);
  const period = (p?: Row) => (p ? `${money(p.fees)} fees · ${money(Number(p.raised) - Number(p.fees))} net` : '');
  const tasksOpen = (myTasks.data as Row[]) ?? [];
  const today = iso(new Date());

  return (
    <section className="view">
      <div className="view-head"><div className="view-title"><h1>Dashboard</h1></div></div>
      {q.error && <div className="error">{q.error}</div>}

      <div className="kpis">
        <Kpi label="Today" value={money(s?.periods.today.raised ?? 0)} icon={<Clock size={18} />} tone="green" sub={period(s?.periods.today)} />
        <Kpi label="This week" value={money(s?.periods.week.raised ?? 0)} icon={<CalendarDays size={18} />} tone="green" sub={period(s?.periods.week)} />
        <Kpi label="This month" value={money(s?.periods.month.raised ?? 0)} icon={<CalendarRange size={18} />} tone="green" sub={period(s?.periods.month)} />
        {isAdmin && <Kpi label="This year" value={money(s?.periods.year.raised ?? 0)} icon={<TrendingUp size={18} />} tone="green" sub={period(s?.periods.year)} />}
        <Kpi label="Pledged (open)" value={money(s?.pledged ?? 0)} icon={<Handshake size={18} />} tone="blue" sub="Not confirmed income" />
        <Kpi label="Recurring pledges" value={money(s?.scheduled_30 ?? 0)} icon={<CalendarClock size={18} />} tone="violet" sub={`next 30 days · ${money(s?.scheduled_90 ?? 0)} next 90`} />
        {isAdmin && <Kpi label="Tasks waiting" value={<Link to="/task-sheet">{taskCount}</Link>} icon={<AlertTriangle size={18} />} tone="amber" sub="On the Task Sheet" />}
        {!isAdmin && <Kpi label="My tasks" value={<Link to="/tasks">{tasksOpen.length}</Link>} icon={<AlertTriangle size={18} />} tone="amber" sub={`${tasksOpen.filter(t => t.due_date && t.due_date < today).length} overdue`} />}
      </div>

      {!isAdmin && (
        <div className="quick-links">
          <Link className="btn" to="/donors">Look up a donor</Link>
          <Link className="btn" to="/donors">Add a donor</Link>
          <Link className="btn" to="/pledges">Add a pledge</Link>
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

      <div className="card">
        <h3>Donations over time</h3>
        <p className="range-total">
          <b>{money(s?.range.raised ?? 0)}</b> raised · {money(s?.range.fees ?? 0)} fees · {money(Number(s?.range.raised ?? 0) - Number(s?.range.fees ?? 0))} net · {s?.range.count ?? 0} gifts
          {compare && prior.data && <span className="muted"> · {change(Number(s?.range.raised ?? 0), Number((prior.data as Row).range.raised))}</span>}
        </p>
        <DailyChart daily={s?.daily ?? []} from={from} to={to} />
      </div>

      <div className="cards">
        <Ranked title={isAdmin ? 'Top campaigns' : 'My campaigns'} rows={s?.top_campaigns ?? []} to={r => `/campaigns/${encodeURIComponent(r.id)}`} />
        {isAdmin && <Ranked title="Most active fundraisers" rows={s?.top_fundraisers ?? []} to={r => `/managers/${encodeURIComponent(r.id)}`} />}
        <Ranked title="By source" rows={s?.sources ?? []} />
        <div className="card">
          <h3>Latest donations</h3>
          <table className="mini"><tbody>
            {((recent.data as Row[]) ?? []).map(d => (
              <tr key={d.id}>
                <td>{donorName(d) || d.name || 'Anonymous'}<div className="muted small">{d.campaigns?.internal_name} · {dateTime(d.created_at)}</div></td>
                <td className="right num">{money(d.amount)}</td>
              </tr>
            ))}
          </tbody></table>
        </div>
        <Ranked title="Overdue pledges by campaign" rows={overdueByCampaign} to={r => `/campaigns/${encodeURIComponent(r.id)}`} />
        <div className="card">
          <h3>{isAdmin ? 'Near their goal' : 'Campaign progress'}</h3>
          <table className="mini"><tbody>
            {(isAdmin ? nearGoal : list).map(c => {
              const share = Number(c.goal) > 0 ? Number(c.combined_raised) / Number(c.goal) : null;
              return (
                <tr key={c.id}>
                  <td>
                    <Link to={`/campaigns/${encodeURIComponent(c.id)}`}>{c.internal_name}</Link>
                    {share !== null && <div className="bar"><span style={{ width: `${Math.min(share, 1) * 100}%` }} /></div>}
                  </td>
                  <td className="right num">{c.balance_mode === 'shared' ? <span className="muted">Shared</span> : <Balance value={c.balance} />}{share !== null && <div className="muted small">{Math.round(share * 100)}% of {money(c.goal)}</div>}</td>
                </tr>
              );
            })}
            {(isAdmin ? nearGoal : list).length === 0 && <tr><td className="muted">{isAdmin ? <><Target size={13} /> No campaign within 10% of its goal</> : 'No active campaigns'}</td></tr>}
          </tbody></table>
        </div>
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
