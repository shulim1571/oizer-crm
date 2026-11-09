import PageTabs, { usePageTab } from '../components/PageTabs';
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
import { dateTime, money } from '../lib/format';
import { donorFields, fundraiserDonorFields, taskFields } from '../lib/schemas';
import { DONATION_SELECT, donationColumns, isLive } from './donationColumns';
import { ContactLog, DonorLookup, DonorPledges } from './DonorExtras';
import { DonorReceipts } from './Receipts';
import { SavedCards } from './Payments';
import { NewPledgeButtons } from './Pledges';

export function DonorsPage() {
  const nav = useNavigate();
  const { isAdmin, canWork } = useAuth();
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const { data, error, loading } = useQuery(() =>
    fetchAll((a, b) => supabase.from('donor_summary').select('*').order('total_given', { ascending: false }).range(a, b)),
  );

  return (
    <>
      {canWork && <DonorLookup />}
      {addError && <div className="error">{addError}</div>}
      <DataTable
        title={isAdmin ? 'Donors' : 'My Donors'}
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
          { key: 'open_pledges', label: 'Open Pledges', render: r => money(r.open_pledges), align: 'right' },
          { key: 'id', label: 'Donor ID', optional: true },
          { key: 'country', label: 'Country', optional: true },
          { key: 'phone', label: 'Phone' },
          { key: 'email', label: 'Email' },
          { key: 'address', label: 'Address', long: true, optional: true },
          { key: 'campaign_count', label: 'Campaigns', optional: true, align: 'right' },
          { key: 'last_gift_at', label: 'Last Gift', render: r => dateTime(r.last_gift_at) },
          { key: 'matbia_id', label: 'Matbia ID', optional: true },
          { key: 'ojc_id', label: 'OJC ID', optional: true },
        ]}
        more={[{ label: 'Possible duplicates', onClick: () => nav('/donors/duplicates'), hidden: !isAdmin }]}
        actions={canWork && <button className="btn primary" onClick={() => setAdding(true)}><Plus size={16} /> New donor</button>}
      />
      {adding && !isAdmin && (
        <FundraiserNewDonor onClose={() => setAdding(false)} onError={setAddError} />
      )}
      {adding && isAdmin && (
        <RecordForm table="donors" title="New Donor" fields={donorFields} defaults={{ country: 'US' }} onClose={() => setAdding(false)} onSaved={r => nav(`/donors/${r.id}`)} />
      )}
    </>
  );
}

/** Goes through a function, which also puts the new donor on this fundraiser's list. */
function FundraiserNewDonor({ onClose, onError }: { onClose: () => void; onError: (m: string | null) => void }) {
  const nav = useNavigate();
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [address, setAddress] = useState('');
  const [country, setCountry] = useState('US');
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    onError(null);
    const { data, error: e } = await supabase.rpc('add_fundraiser_donor', { p_fields: { first_name: first, last_name: last, phone: phone || null, email: email || null, address: address || null, country } });
    if (e) return setError(e.message);
    nav(`/donors/${encodeURIComponent(data)}`);
  }

  return (
    <div className="modal-back" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="modal"><div className="record-form">
        <div className="form-head"><h2>New donor</h2></div>
        <p className="muted small">Look them up first, so nobody ends up with two records. You can add a pledge or a follow-up task on the next screen.</p>
        <div className="fields">
          <label className="field"><span>First name *</span><input value={first} onChange={e => setFirst(e.target.value)} /></label>
          <label className="field"><span>Last name *</span><input value={last} onChange={e => setLast(e.target.value)} /></label>
          <label className="field"><span>Phone</span><input value={phone} onChange={e => setPhone(e.target.value)} /></label>
          <label className="field"><span>Email</span><input type="email" value={email} onChange={e => setEmail(e.target.value)} /></label>
          <label className="field"><span>Address</span><input value={address} onChange={e => setAddress(e.target.value)} /></label>
          <label className="field"><span>Country</span>
            <select value={country} onChange={e => setCountry(e.target.value)}>
              <option value="US">USA</option><option value="CA">Canada</option><option value="IL">Israel</option><option value="GB">England</option>
            </select>
          </label>
        </div>
        {error && <div className="error">{error}</div>}
        <div className="form-actions">
          <div className="spacer" />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={!first.trim() || !last.trim()} onClick={save}>Add donor</button>
        </div>
      </div></div>
    </div>
  );
}

const DONOR_TABS = [['overview', 'Overview'], ['giving', 'Giving history'], ['pledges', 'Pledges'], ['tasks', 'Tasks & contact log'], ['receipts', 'Receipts & cards']] as const;

export function DonorDetail() {
  const [tab, setTab] = usePageTab(DONOR_TABS.map(([k]) => k));
  const { id = '' } = useParams();
  const nav = useNavigate();
  const { isAdmin, canWork } = useAuth();
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
    const { data } = await supabase.from('tasks').select('*, campaigns(id, internal_name, campaign_name)').eq('donor_id', id).order('created_at', { ascending: false });
    return data ?? [];
  }, [id, version]);

  const byCampaign = useMemo(() => {
    const m = new Map<string, { label: string; total: number; count: number }>();
    for (const g of gifts.data ?? []) {
      if (!isLive(g)) continue;
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
      if (!isLive(g)) continue;
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
            <span>Donor since {dateTime(d.first_gift_at ?? d.created_at)}</span>
          </div>
        </div>
        <div className="spacer" />
        {canWork && <button className="btn" onClick={() => setEditing(true)}><Pencil size={16} /> Edit donor</button>}
      </div>

      <div className="kpis">
        <Kpi label="Lifetime giving" value={money(d.total_given)} icon={<TrendingUp size={18} />} tone="green" />
        <Kpi label="Gifts" value={d.gift_count} icon={<HandCoins size={18} />} tone="violet"
             sub={`avg ${money(d.gift_count ? d.total_given / d.gift_count : 0)}`} />
        <Kpi label="Campaigns" value={d.campaign_count ?? 0} icon={<Landmark size={18} />} tone="blue" />
        <Kpi label="Last gift" value={dateTime(d.last_gift_at) || '—'} icon={<CalendarDays size={18} />} tone="amber" small />
      </div>

      <PageTabs tabs={DONOR_TABS} value={tab} onChange={setTab} />

      {tab === 'overview' && <div className="cards">
        <div className="card">
          <h3>Contact</h3>
          <dl>
            <dt>Phone</dt><dd>{d.phone || '—'}</dd>
            <dt>Email</dt><dd>{d.email || '—'}</dd>
            <dt>Address</dt><dd>{d.address?.trim() || '—'}</dd>
            <dt>OJC / Matbia</dt><dd>{[d.ojc_id, d.matbia_id].filter(Boolean).join(' / ') || '—'}</dd>
            <dt>Pledger / Nadvan</dt><dd>{[d.pledger_id, d.nadvan_id].filter(Boolean).join(' / ') || '—'}</dd>
            <dt>Country</dt><dd>{d.country}</dd>
            <dt>Donor ID</dt><dd>{d.id}</dd>
            {isAdmin && <><dt>Notes</dt><dd className="pre-line">{d.notes || '—'}</dd></>}
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
        </div>
      </div>}

      {tab === 'tasks' && <>
        {canWork && <div className="tab-actions"><button className="btn primary" onClick={() => setAddingTask(true)}><Plus size={16} /> Follow-up task</button></div>}
        <div className="cards">
          <div className="card">
            <h3>Open tasks</h3>
            <ul className="plain">
              {(tasks.data ?? []).filter(t => t.status !== 'Done').map(t => (
                <li key={t.id}>{t.title} <span className="muted">· {campLabel(t.campaigns)} · {t.status}</span></li>
              ))}
              {(tasks.data ?? []).filter(t => t.status !== 'Done').length === 0 && <li className="muted">None</li>}
            </ul>
          </div>
          <ContactLog donorId={d.id} />
        </div>
      </>}

      {tab === 'pledges' && <>
        {canWork && <div className="tab-actions"><NewPledgeButtons donorId={d.id} onSaved={() => setVersion(v => v + 1)} /></div>}
        <div className="cards"><DonorPledges donorId={d.id} onChanged={() => setVersion(v => v + 1)} /></div>
      </>}

      {tab === 'receipts' && <div className="cards">
        <DonorReceipts donor={d} />
        <SavedCards donor={d} />
      </div>}

      {tab === 'giving' && <DataTable
        title="Giving history"
        exportName={`donor-${d.id}`}
        rows={gifts.data ?? []}
        loading={gifts.loading}
        error={gifts.error}
        columns={donationColumns().filter(c => c.key !== 'donor')}
        serverSearch
      />}
      <p className="muted pad">Last updated {dateTime(d.updated_at)}</p>

      {editing && (
        <RecordForm table="donors" title="Edit Donor" fields={isAdmin ? donorFields : fundraiserDonorFields()} record={d} allowDelete={isAdmin}
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
