import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, CalendarDays, HandCoins, Landmark, Pencil, Plus, TrendingUp } from 'lucide-react';
import Kpi from '../components/Kpi';
import DataTable from '../components/DataTable';
import RecordForm from '../components/RecordForm';
import { campLabel } from '../components/CrudPage';
import { fetchAll, supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';
import { useAuth } from '../lib/auth';
import { date, dateTime, money } from '../lib/format';
import { donorFields, taskFields } from '../lib/schemas';
import { DONATION_SELECT, donationColumns } from './donationColumns';

export function DonorsPage() {
  const nav = useNavigate();
  const { isAdmin } = useAuth();
  const [adding, setAdding] = useState(false);
  const { data, error, loading } = useQuery(() =>
    fetchAll((a, b) => supabase.from('donor_summary').select('*').order('total_given', { ascending: false }).range(a, b)),
  );

  return (
    <>
      <DataTable
        title="Donors"
        rows={data ?? []}
        loading={loading}
        error={error}
        onOpen={r => nav(`/donors/${r.id}`)}
        initialSort={{ key: 'total_given', dir: 'desc' }}
        columns={[
          {
            key: 'display_name', label: 'Donor', width: 220,
            value: r => `${r.display_name} ${r.yiddish_name ?? ''}`,
            render: r => (
              <div className="person">
                <span className="avatar sm">{(r.display_name || '?')[0]}</span>
                <div>
                  <div>{r.display_name}</div>
                  {r.yiddish_name && r.yiddish_name !== r.display_name && <div className="muted small">{r.yiddish_name}</div>}
                </div>
              </div>
            ),
          },
          { key: 'total_given', label: 'Total Given', render: r => <b className="num">{money(r.total_given)}</b>, align: 'right' },
          { key: 'gift_count', label: 'Gifts', align: 'right' },
          { key: 'phone', label: 'Phone' },
          { key: 'email', label: 'Email' },
          { key: 'address', label: 'Address' },
          { key: 'campaign_count', label: 'Campaigns', align: 'right' },
          { key: 'last_gift_at', label: 'Last Gift', render: r => date(r.last_gift_at) },
          { key: 'matbia_id', label: 'Matbia ID' },
          { key: 'ojc_id', label: 'OJC ID' },
        ]}
        actions={isAdmin && <button className="btn primary" onClick={() => setAdding(true)}><Plus size={16} /> New donor</button>}
      />
      {adding && (
        <RecordForm table="donors" title="New Donor" fields={donorFields} onClose={() => setAdding(false)} onSaved={r => nav(`/donors/${r.id}`)} />
      )}
    </>
  );
}

export function DonorDetail() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const { isAdmin, role } = useAuth();
  const [editing, setEditing] = useState(false);
  const [addingTask, setAddingTask] = useState(false);
  const [version, setVersion] = useState(0);

  const donor = useQuery(async () => {
    const { data, error } = await supabase.from('donor_summary').select('*').eq('id', id).maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  }, [id, version]);

  const gifts = useQuery(() =>
    fetchAll((a, b) => supabase.from('donations').select(DONATION_SELECT).eq('donor_id', id).order('created_at', { ascending: false }).range(a, b)),
  [id, version]);

  const tasks = useQuery(async () => {
    const { data } = await supabase.from('tasks').select('*, campaigns(id, real_name, campaign_name)').eq('donor_id', id).order('created_at', { ascending: false });
    return data ?? [];
  }, [id, version]);

  const byCampaign = useMemo(() => {
    const m = new Map<string, { label: string; total: number; count: number }>();
    for (const g of gifts.data ?? []) {
      if (g.type === 'Voided') continue;
      const k = g.campaign_id ?? '';
      const e = m.get(k) ?? { label: campLabel(g.campaigns) || '(none)', total: 0, count: 0 };
      e.total += Number(g.amount);
      e.count++;
      m.set(k, e);
    }
    return [...m.values()].sort((a, b) => b.total - a.total);
  }, [gifts.data]);

  const byYear = useMemo(() => {
    const m = new Map<string, number>();
    for (const g of gifts.data ?? []) {
      if (g.type === 'Voided') continue;
      const y = new Date(g.created_at).getFullYear().toString();
      m.set(y, (m.get(y) ?? 0) + Number(g.amount));
    }
    return [...m.entries()].sort();
  }, [gifts.data]);

  const d = donor.data;
  if (donor.loading && !d) return <div className="view"><p className="muted pad">Loading…</p></div>;
  if (!d) return <div className="view"><p className="pad">Donor not found or you don't have access.</p></div>;

  return (
    <div className="detail">
      <div className="detail-head">
        <button className="icon-btn outlined" onClick={() => nav(-1)} title="Back"><ArrowLeft size={18} /></button>
        <div className="hero-avatar">{(d.display_name || '?')[0]}</div>
        <div>
          <h1>{d.english_title ? `${d.english_title} ` : ''}{d.display_name}</h1>
          <div className="sub">
            {d.yiddish_name && d.yiddish_name !== d.display_name && <span className="hebrew">{d.yiddish_name}</span>}
            <span>Donor since {date(d.first_gift_at ?? d.created_at)}</span>
          </div>
        </div>
        <div className="spacer" />
        {(role === 'admin' || role === 'manager') && (
          <button className="btn" onClick={() => setAddingTask(true)}><Plus size={16} /> Follow-up task</button>
        )}
        {isAdmin && <button className="btn" onClick={() => setEditing(true)}><Pencil size={16} /> Edit</button>}
      </div>

      <div className="kpis">
        <Kpi label="Lifetime giving" value={money(d.total_given)} icon={<TrendingUp size={18} />} tone="green" />
        <Kpi label="Gifts" value={d.gift_count} icon={<HandCoins size={18} />} tone="violet"
             sub={`avg ${money(d.gift_count ? d.total_given / d.gift_count : 0)}`} />
        <Kpi label="Campaigns" value={d.campaign_count ?? 0} icon={<Landmark size={18} />} tone="blue" />
        <Kpi label="Last gift" value={date(d.last_gift_at) || '—'} icon={<CalendarDays size={18} />} tone="amber" small />
      </div>

      <div className="cards">
        <div className="card">
          <h3>Contact</h3>
          <dl>
            <dt>Phone</dt><dd>{d.phone || '—'}</dd>
            <dt>Email</dt><dd>{d.email || '—'}</dd>
            <dt>Address</dt><dd>{d.address?.trim() || '—'}</dd>
            <dt>OJC / Matbia</dt><dd>{[d.ojc_id, d.matbia_id].filter(Boolean).join(' / ') || '—'}</dd>
            <dt>Pledger / Nadvan</dt><dd>{[d.pledger_id, d.nadvan_id].filter(Boolean).join(' / ') || '—'}</dd>
            <dt>Notes</dt><dd>{d.notes || '—'}</dd>
          </dl>
        </div>
        <div className="card">
          <h3>Giving by campaign</h3>
          <table className="mini">
            <tbody>
              {byCampaign.slice(0, 8).map(c => (
                <tr key={c.label}>
                  <td>
                    {c.label} <span className="muted small">· {c.count}</span>
                    <div className="bar"><span style={{ width: `${(c.total / (byCampaign[0]?.total || 1)) * 100}%` }} /></div>
                  </td>
                  <td className="right num">{money(c.total)}</td>
                </tr>
              ))}
              {byCampaign.length === 0 && <tr><td className="muted">{gifts.loading ? 'Loading…' : 'No gifts yet'}</td></tr>}
              {byCampaign.length > 8 && (
                <tr><td colSpan={2} className="muted small">+ {byCampaign.length - 8} more campaigns in the history below</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="card">
          <h3>Giving by year</h3>
          <table className="mini">
            <tbody>{byYear.map(([y, t]) => <tr key={y}><td>{y}</td><td className="right">{money(t)}</td></tr>)}</tbody>
          </table>
          <h3>Open tasks</h3>
          <ul className="plain">
            {(tasks.data ?? []).filter(t => t.status !== 'Done').map(t => (
              <li key={t.id}>{t.title} <span className="muted">· {campLabel(t.campaigns)} · {t.status}</span></li>
            ))}
            {(tasks.data ?? []).filter(t => t.status !== 'Done').length === 0 && <li className="muted">None</li>}
          </ul>
        </div>
      </div>

      <DataTable
        title="Giving history"
        exportName={`donor-${d.id}`}
        rows={gifts.data ?? []}
        loading={gifts.loading}
        error={gifts.error}
        columns={donationColumns().filter(c => c.key !== 'donor')}
        serverSearch
      />
      <p className="muted pad">Last updated {dateTime(d.updated_at)}</p>

      {editing && (
        <RecordForm table="donors" title="Edit Donor" fields={donorFields} record={d} allowDelete
                    onClose={() => setEditing(false)}
                    onSaved={r => { setEditing(false); if (r._deleted) nav('/donors'); else setVersion(v => v + 1); }} />
      )}
      {addingTask && (
        <RecordForm table="tasks" title="New follow-up task" fields={taskFields}
                    defaults={{ donor_id: d.id, status: 'Pending', campaign_id: byCampaign.length ? gifts.data?.[0]?.campaign_id : null }}
                    onClose={() => setAddingTask(false)} onSaved={() => { setAddingTask(false); setVersion(v => v + 1); }} />
      )}
    </div>
  );
}
