import AddressEditor from '../components/AddressEditor';
import { lastFirst } from '../lib/nameSort';
import { applyColumnFilters, useDonationEditor } from './Donations';
import PageTabs, { usePageTab } from '../components/PageTabs';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, CalendarDays, HandCoins, Landmark, Pencil, Plus, Search, TrendingUp } from 'lucide-react';
import Kpi from '../components/Kpi';
import DataTable, { type Column, type ServerQuery } from '../components/DataTable';
import Pager from '../components/Pager';
import { useSearch } from '../components/Layout';
import RecordForm from '../components/RecordForm';
import { campLabel } from '../components/CrudPage';
import { fetchAll, supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';
import { useAuth } from '../lib/auth';
import { dateTime, money, formatPhone } from '../lib/format';
import { donorFields, fundraiserDonorFields, taskFields } from '../lib/schemas';
import { DONATION_SELECT, donationColumns, isLive } from './donationColumns';
import { ContactLog, DonorPledges } from './DonorExtras';
import { DonorReceipts } from './Receipts';
import { SavedCards } from './Payments';
import { NewPledgeButtons } from './Pledges';

/*
 * Donors list (Moshe Henig, 2026-11-15): one list that searches itself on the server. A search shows every match,
 * page by page, never a capped extract with the whole list under it. Search covers name, Yiddish name, email,
 * donor ID and phone digits (any formatting); every word must match. Sorting and column filters run on the server too.
 * Fundraisers also see how many other donors in the organization match, to add them to their list.
 */
const DONOR_COLUMNS: Column[] = [
  {
    key: 'display_name', label: 'Donor', width: 220, filter: { column: 'display_name', type: 'text' },
    value: r => `${r.display_name} ${r.yiddish_name ?? ''}`,
    sortValue: r => lastFirst(r, 'display_name'),
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
  { key: 'total_given', label: 'Total Given', render: r => <b className="num">{money(r.total_given)}</b>, align: 'right', filter: { column: 'total_given', type: 'number' } },
  { key: 'gift_count', label: 'Gifts', align: 'right', filter: { column: 'gift_count', type: 'number' } },
  { key: 'open_pledges', label: 'Open Pledges', render: r => money(r.open_pledges), align: 'right', filter: { column: 'open_pledges', type: 'number' } },
  { key: 'id', label: 'Donor ID', optional: true, filter: { column: 'id', type: 'text' } },
  { key: 'country', label: 'Country', optional: true, filter: { column: 'country', type: 'text' } },
  { key: 'cell_phone', label: 'Cell', render: r => formatPhone(r.cell_phone), filter: { column: 'cell_phone', type: 'text' } },
  { key: 'home_phone', label: 'Home', render: r => formatPhone(r.home_phone), filter: { column: 'home_phone', type: 'text' } },
  { key: 'email', label: 'Email', filter: { column: 'email', type: 'text' } },
  { key: 'address', label: 'Address', long: true, optional: true, filter: { column: 'address', type: 'text' } },
  { key: 'campaign_count', label: 'Campaigns', optional: true, align: 'right', filter: { column: 'campaign_count', type: 'number' } },
  { key: 'last_gift_at', label: 'Last Gift', render: r => dateTime(r.last_gift_at), filter: { column: 'last_gift_at', type: 'date' } },
  { key: 'matbia_id', label: 'Matbia account #', optional: true, filter: { column: 'matbia_id', type: 'text' } },
  { key: 'ojc_id', label: 'OJC account #', optional: true, filter: { column: 'ojc_id', type: 'text' } },
];

/** The search, as conditions on donor_summary: every word must match a name, email or ID; digits also match phones. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function donorSearch(base: any, text: string, phoneIds: string[] | null) {
  let s = base;
  const words = text.trim().replace(/[,()*%\\"]/g, ' ').split(/\s+/).filter(Boolean);
  const byPhone = phoneIds?.length ? `,id.in.(${phoneIds.map(id => `"${id.replace(/"/g, '')}"`).join(',')})` : '';
  if (words.length > 1 && byPhone) {
    // "718 555 0100": the digits together match a phone; or every word matches a name.
    const each = words.map(w => `or(display_name.ilike.*${w}*,yiddish_name.ilike.*${w}*,email.ilike.*${w}*,id.ilike.${w})`).join(',');
    return s.or(`and(${each})${byPhone}`);
  }
  for (const w of words) s = s.or(`display_name.ilike.*${w}*,yiddish_name.ilike.*${w}*,email.ilike.*${w}*,id.ilike.${w}${byPhone}`);
  return s;
}

export function DonorsPage() {
  const nav = useNavigate();
  const { isAdmin, canWork } = useAuth();
  const { q, setQ } = useSearch();
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [query, setQuery] = useState<ServerQuery | null>(null);
  const [page, setPage] = useState(0);
  const [debounced, setDebounced] = useState(q);
  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 300); return () => clearTimeout(t); }, [q]);

  // Phone digits, any formatting (4 or more digits typed).
  const digits = debounced.replace(/\D/g, '');
  const phone = useQuery(async () => (digits.length >= 4 ? ((await supabase.rpc('donor_ids_by_phone', { p_digits: digits })).data ?? []) as string[] : null), [digits]);

  const queryKey = JSON.stringify([debounced, query, phone.data]);
  useEffect(() => setPage(0), [queryKey]);
  const conditions = (base: unknown) => {
    let s = donorSearch(base, debounced, phone.data);
    if (query) s = applyColumnFilters(s, DONOR_COLUMNS, query.filters);
    return s;
  };
  const ordered = (s: ReturnType<typeof conditions>) => {
    const sort = query?.sort ?? { key: 'total_given', dir: 'desc' as const };
    const asc = sort.dir === 'asc';
    // By name means by last name, then first name, as the list always sorted.
    if (sort.key === 'display_name') return s.order('last_name', { ascending: asc, nullsFirst: false }).order('first_name', { ascending: asc }).order('id');
    const col = DONOR_COLUMNS.find(c => c.key === sort.key)?.filter?.column ?? 'total_given';
    return s.order(col, { ascending: asc, nullsFirst: false }).order('id');
  };
  const list = useQuery(async () => {
    if (!query || (digits.length >= 4 && phone.loading)) return null;
    const size = query.pageSize;
    const { data, count, error } = await ordered(conditions(supabase.from('donor_summary').select('*', { count: 'exact' })))
      .range(page * size, page * size + size - 1);
    if (error) throw new Error(error.message);
    return { rows: (data ?? []) as Row[], count: count ?? 0 };
  }, [queryKey, page, phone.loading], { live: ['gifts', 'pledges'] });
  const count = list.data?.count ?? 0;
  const pages = query ? Math.ceil(count / query.pageSize) : 0;
  const exportAll = () => fetchAll((a, b) => ordered(conditions(supabase.from('donor_summary').select('*'))).range(a, b));

  return (
    <>
      {addError && <div className="error">{addError}</div>}
      <DataTable
        title={isAdmin ? 'Donors' : 'My Donors'}
        viewKey="Donors (server)"
        subtitle={debounced
          ? `${count.toLocaleString()} donor${count === 1 ? '' : 's'} match “${debounced}”`
          : `${count.toLocaleString()} donor${count === 1 ? '' : 's'}`}
        rows={list.data?.rows ?? []}
        loading={list.loading || !query}
        error={list.error}
        columns={DONOR_COLUMNS}
        serverSearch
        onServerQuery={setQuery}
        exportAll={exportAll}
        onOpen={r => nav(`/donors/${r.id}`)}
        initialSort={{ key: 'total_given', dir: 'desc' }}
        summary={
          <div className="donor-search">
            <label className="lookup-box">
              <Search size={20} />
              <input aria-label="Search donors" value={q} placeholder="Search donors by name, phone, email or ID…" onChange={e => setQ(e.target.value)} />
              {q && <button type="button" className="link" onClick={() => setQ('')}>Clear</button>}
            </label>
            {!isAdmin && canWork && debounced.length >= 2 && <OtherOrgDonors q={debounced} />}
          </div>
        }
        more={[{ label: 'Possible duplicates', onClick: () => nav('/donors/duplicates'), hidden: !isAdmin }]}
        actions={canWork && <button className="btn primary" onClick={() => setAdding(true)}><Plus size={16} /> New donor</button>}
        footer={
          <>
            <span>Page {page + 1} of {Math.max(pages, 1)}</span>
            <Pager page={page} pages={pages} onPage={setPage} />
          </>
        }
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

/**
 * Fundraisers: donors in the organization who match the search but aren't on their list yet. One line with the
 * count; Show lists them, 50 at a time (Load more), and opening one adds them to the list.
 */
function OtherOrgDonors({ q }: { q: string }) {
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const load = async (offset: number) => {
    const { data, error: e } = await supabase.rpc('lookup_donors', { p_q: q, p_limit: offset ? 50 : (open ? 50 : 1), p_offset: offset, p_not_mine: true });
    if (e) return setError(e.message);
    const got = (data ?? []) as Row[];
    setTotal(Number(got[0]?.total_count ?? (offset ? total : 0)));
    setRows(r => (offset ? [...r, ...got] : got));
  };
  useEffect(() => { setRows([]); void load(0); }, [q, open]);   // eslint-disable-line react-hooks/exhaustive-deps
  async function add(d: Row) {
    const { error: e } = await supabase.rpc('link_donor', { p_donor: d.id });
    if (e) return setError(e.message);
    nav(`/donors/${encodeURIComponent(d.id)}`);
  }
  if (error) return <div className="error">{error}</div>;
  if (!total) return null;
  return (
    <div className="other-donors">
      <span className="muted small">{total.toLocaleString()} more donor{total === 1 ? '' : 's'} in the organization match, not on your list yet.</span>{' '}
      <button type="button" className="link" onClick={() => setOpen(o => !o)}>{open ? 'Hide' : 'Show'}</button>
      {open && (
        <div className="lookup-results">
          {rows.map(d => (
            <button type="button" key={d.id} onClick={() => add(d)}>
              <b>{d.display_name}</b>
              {d.yiddish_name && d.yiddish_name !== d.display_name && <span className="hebrew"> {d.yiddish_name}</span>}
              <span className="muted small"> {[formatPhone(d.phone), d.email].filter(Boolean).join(' · ') || `#${d.id}`} · add to my list</span>
            </button>
          ))}
          {rows.length < total && <button type="button" className="link" onClick={() => load(rows.length)}>Load more ({(total - rows.length).toLocaleString()} left)</button>}
        </div>
      )}
    </div>
  );
}

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
          <label className="field"><span>Cell phone</span><input type="tel" value={phone} onChange={e => setPhone(e.target.value)} /></label>
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
  // Edit the address right from the Address section (Moshe Henig, 2026-11-12).
  const [editingAddress, setEditingAddress] = useState(false);
  const [addingTask, setAddingTask] = useState(false);
  const [version, setVersion] = useState(0);

  const donor = useQuery(async () => {
    const { data, error } = await supabase.from('donor_summary').select('*').eq('id', id).maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  }, [id, version], { live: ['gifts', 'pledges'] });

  const gifts = useQuery(() =>
    fetchAll((a, b) => supabase.from('donations').select(DONATION_SELECT).eq('donor_id', id).order('created_at', { ascending: false }).range(a, b)),
  [id, version], { live: ['gifts'] });

  // Edit a donation straight from the giving history (Moshe Henig, 2026-11-12): the same editor and rules as the
  // Transactions list, so only those who can edit donations can, and the change log is the same.
  const giftEditor = useDonationEditor(() => setVersion(v => v + 1));
  const giftColumns = useMemo(() => [
    ...(isAdmin ? [{ key: '_edit', label: '', width: 60, render: (r: Row) => (
      <button type="button" className="link" onClick={e => { e.stopPropagation(); giftEditor.open?.(r); }}>Edit</button>
    ) }] : []),
    ...donationColumns().filter(c => c.key !== 'donor'),
  ], [isAdmin]);   // eslint-disable-line react-hooks/exhaustive-deps

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
        <button className="icon-btn outlined" onClick={() => nav(-1)} title="Back"><ArrowLeft size={20} /></button>
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
        <Kpi label="Lifetime giving" value={money(d.total_given)} icon={<TrendingUp size={16} />} tone="green" />
        <Kpi label="Gifts" value={d.gift_count} icon={<HandCoins size={16} />} tone="violet"
             sub={`avg ${money(d.gift_count ? d.total_given / d.gift_count : 0)}`} />
        <Kpi label="Campaigns" value={d.campaign_count ?? 0} icon={<Landmark size={16} />} tone="blue" />
        <Kpi label="Last gift" value={dateTime(d.last_gift_at) || '—'} icon={<CalendarDays size={16} />} tone="amber" small />
      </div>

      <PageTabs tabs={DONOR_TABS} value={tab} onChange={setTab} />

      {tab === 'overview' && <div className="cards">
        <div className="card">
          <h3>Contact</h3>
          <dl>
            <dt>Cell</dt><dd>{formatPhone(d.cell_phone) || '—'}</dd>
            <dt>Home</dt><dd>{formatPhone(d.home_phone) || '—'}</dd>
            <dt>Email</dt><dd>{d.email || '—'}</dd>
            <dt>Address</dt><dd>
              <span className="pre-line">{d.address?.trim() || '—'}</span>
              {canWork && <> <button type="button" className="link" onClick={() => setEditingAddress(true)}>{d.address?.trim() ? 'Edit address' : 'Add address'}</button></>}
            </dd>
            {/* Plain words for the giving-fund account numbers (readiness #64). */}
            <dt>OJC account number</dt><dd>{d.ojc_id || '—'}</dd>
            <dt>Matbia account number</dt><dd>{d.matbia_id || '—'}</dd>
            <dt>Pledger account number</dt><dd>{d.pledger_id || '—'}</dd>
            <dt>Nadvan account number</dt><dd>{d.nadvan_id || '—'}</dd>
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
        columns={giftColumns}
        onOpen={giftEditor.open}
        serverSearch
      />}
      {giftEditor.editor}
      <p className="muted pad">Last updated {dateTime(d.updated_at)}</p>

      {editingAddress && <AddressEditor donor={d} onClose={() => setEditingAddress(false)} onSaved={() => { setEditingAddress(false); setVersion(v => v + 1); }} />}
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
