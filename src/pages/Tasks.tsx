import { NewDonorDialog } from '../components/DonorPicker';
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, X } from 'lucide-react';
import DataTable, { type Column } from '../components/DataTable';
import { campLabel } from '../components/CrudPage';
import DateNote from '../components/DateNote';
import RecordForm from '../components/RecordForm';
import SearchSelect from '../components/SearchSelect';
import { StatusPill } from '../components/Pill';
import { useAuth } from '../lib/auth';
import { localToday, dateTime, download, money, toCsv } from '../lib/format';
import { campaignOptions, donorOptions, managerOptions, type Option } from '../lib/lookups';
import { adminTaskFields, taskFields } from '../lib/schemas';
import { fetchAll, supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';
import { Overlay, PledgeDialog } from './Pledges';

const CAMP = 'id, internal_name, campaign_name, external_name';
const SELECT = `*, campaigns(${CAMP}), donors(display_name), owner:managers!tasks_owner_fkey(full_name), task_call_items(contacted)`;
const today = () => localToday();
const isOverdue = (r: Row) => r.status !== 'Done' && r.due_date && r.due_date < today();
const statusOf = (r: Row) => (isOverdue(r) ? 'Overdue' : r.status);

/** Overdue first, then by due date, undated next, and finished ones last. */
const rank = (r: Row) => (r.status === 'Done' ? 3 : isOverdue(r) ? 0 : r.due_date ? 1 : 2);
const byDue = (a: Row, b: Row) => rank(a) - rank(b) || String(a.due_date ?? '').localeCompare(String(b.due_date ?? ''));

const columns = (showOwner: boolean): Column[] => [
  {
    key: 'title', label: 'Task', width: 240,
    render: r => {
      const items: Row[] = r.task_call_items ?? [];
      return <>{r.title}{r.is_call_list && <span className="muted small"> · call list, {items.filter(i => i.contacted).length} of {items.length} reached</span>}</>;
    },
  },
  { key: 'status', label: 'Status', value: statusOf, render: r => <StatusPill value={statusOf(r)} /> },
  { key: 'due_date', label: 'Due' },
  ...(showOwner ? [{ key: 'owner', label: 'Fundraiser', value: (r: Row) => r.owner?.full_name ?? 'Shared on campaign' }] : []),
  { key: 'campaign', label: 'Campaign', value: (r: Row) => campLabel(r.campaigns), width: 190 },
  { key: 'donor', label: 'Donor', value: (r: Row) => r.donors?.display_name },
  { key: 'description', label: 'Description' },
  { key: 'created_at', label: 'Created', render: (r: Row) => dateTime(r.created_at) },
];

export default function TasksPage() {
  const { isAdmin, canWork, profile } = useAuth();
  const [version, setVersion] = useState(0);
  const [form, setForm] = useState<Row | null | undefined>(undefined);
  const [viewing, setViewing] = useState<Row | null>(null);
  const [callList, setCallList] = useState<string | null>(null);
  const [newList, setNewList] = useState(false);
  const [fundraiser, setFundraiser] = useState('');
  const [hideDone, setHideDone] = useState(true);
  const [pledge, setPledge] = useState<string | null>(null);

  const q = useQuery(
    () => fetchAll((a, b) => supabase.from('tasks').select(SELECT).order('created_at', { ascending: false }).range(a, b) as never),
    [version],
  );
  const suggested = useQuery(
    async () => (isAdmin ? [] : (await supabase.from('pledge_list').select('*').eq('status', 'overdue').order('expected_date')).data ?? []) as Row[],
    [isAdmin, version],
  );
  const all = useMemo(() => [...((q.data as Row[]) ?? [])].sort(byDue), [q.data]);
  const fundraisers = [...new Set(all.map(r => r.owner?.full_name).filter(Boolean))].sort();
  const rows = all.filter(r => (!hideDone || r.status !== 'Done') && (!fundraiser || r.owner?.full_name === fundraiser));
  const refresh = () => setVersion(v => v + 1);

  // Admins can see a fundraiser's own tasks, but not change them.
  const readOnly = (r: Row) => isAdmin && r.owner_manager_id && r.created_by !== profile?.email;
  const open = (r: Row) => {
    if (r.is_call_list) setCallList(r.id);
    else if (readOnly(r)) setViewing(r);
    else setForm(r);
  };

  return (
    <section className="view">
      {!isAdmin && (suggested.data as Row[] | null)?.length ? (
        <DataTable
          title="Suggested: overdue pledges"
          plain
          rows={suggested.data as Row[]}
          columns={[
            { key: 'reference', label: 'Pledge' },
            { key: 'donor_name', label: 'Donor', width: 180 },
            { key: 'balance', label: 'Remaining', render: r => money(r.balance), align: 'right' },
            { key: 'due', label: 'Was due', value: r => r.next_due_date ?? r.expected_date },
          ]}
          onOpen={r => setPledge(r.id)}
        />
      ) : null}
      <DataTable
        title={isAdmin ? 'Tasks' : 'My Tasks'}
        rows={rows}
        loading={q.loading}
        error={q.error}
        columns={columns(isAdmin)}
        exportName="tasks"
        onOpen={open}
        actions={
          <>
            {isAdmin && (
              <select aria-label="Fundraiser" value={fundraiser} onChange={e => setFundraiser(e.target.value)}>
                <option value="">All fundraisers</option>
                {fundraisers.map(f => <option key={f}>{f}</option>)}
              </select>
            )}
            <label className="inline-check"><input type="checkbox" checked={hideDone} onChange={e => setHideDone(e.target.checked)} /> Hide done</label>
            {canWork && <button className="btn" onClick={() => setNewList(true)}><Plus size={16} /> Call list</button>}
            {canWork && <button className="btn primary" onClick={() => setForm(null)}><Plus size={16} /> Add task</button>}
          </>
        }
      />
      {form !== undefined && (
        <RecordForm
          table="tasks"
          title={form ? 'Edit task' : 'New task'}
          fields={isAdmin ? adminTaskFields() : taskFields}
          record={form}
          defaults={{ status: 'Pending' }}
          allowDelete
          onClose={() => setForm(undefined)}
          onSaved={() => { setForm(undefined); refresh(); }}
        />
      )}
      {viewing && <TaskView task={viewing} onClose={() => setViewing(null)} />}
      {newList && <NewCallListDialog onClose={() => setNewList(false)} onDone={id => { setNewList(false); refresh(); setCallList(id); }} />}
      {callList && <CallListDialog id={callList} onClose={() => { setCallList(null); refresh(); }} />}
      {pledge && <PledgeDialog id={pledge} onClose={() => setPledge(null)} onChanged={refresh} />}
    </section>
  );
}

function TaskView({ task: t, onClose }: { task: Row; onClose: () => void }) {
  return (
    <Overlay onClose={onClose}>
      <div className="form-head">
        <h2>{t.title} <StatusPill value={statusOf(t)} /></h2>
        <button type="button" className="icon-btn" title="Close" onClick={onClose}><X size={18} /></button>
      </div>
      <p className="muted small">This is {t.owner?.full_name ?? 'a fundraiser'}'s personal task. You can see it, but only they can change it.</p>
      <dl className="record-facts">
        {t.due_date && <><dt>Due</dt><dd>{t.due_date}</dd></>}
        {t.campaigns && <><dt>Campaign</dt><dd>{campLabel(t.campaigns)}</dd></>}
        {t.donors && <><dt>Donor</dt><dd>{t.donors.display_name}</dd></>}
        {t.description && <><dt>Description</dt><dd className="pre-line">{t.description}</dd></>}
        {t.notes && <><dt>Notes</dt><dd className="pre-line">{t.notes}</dd></>}
      </dl>
    </Overlay>
  );
}

function NewCallListDialog({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const { isAdmin } = useAuth();
  const [title, setTitle] = useState('');
  const [campaign, setCampaign] = useState<string | null>(null);
  const [due, setDue] = useState('');
  const [owner, setOwner] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [campaigns, setCampaigns] = useState<Option[]>([]);
  const [managers, setManagers] = useState<Option[]>([]);
  const [donors, setDonors] = useState<Option[]>([]);
  const [onCampaign, setOnCampaign] = useState<Set<string> | null>(null);
  const [addingDonor, setAddingDonor] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    campaignOptions().then(setCampaigns);
    donorOptions().then(setDonors);
    if (isAdmin) managerOptions().then(setManagers);
  }, [isAdmin]);
  useEffect(() => {
    if (!campaign) return setOnCampaign(null);
    fetchAll((a, b) => supabase.from('donations').select('donor_id').eq('campaign_id', campaign).not('donor_id', 'is', null).range(a, b) as never)
      .then(rows => setOnCampaign(new Set((rows as Row[]).map(r => r.donor_id))));
  }, [campaign]);

  const shown = donors
    .filter(d => !onCampaign || onCampaign.has(d.value))
    .filter(d => d.label.toLowerCase().includes(search.toLowerCase()))
    .slice(0, 200);
  const toggle = (id: string) => setPicked(p => {
    const next = new Set(p);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  async function save() {
    setError(null);
    const { data, error: e } = await supabase.rpc('create_call_list', {
      p_title: title, p_donors: [...picked], p_campaign: campaign, p_due: due || null, p_owner: owner,
    });
    if (e) return setError(e.message);
    onDone(data);
  }

  return createPortal(
    <div className="modal-back" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-wide"><div className="record-form">
        <div className="form-head"><h2>New call list</h2></div>
        <div className="fields">
          <label className="field"><span>Name *</span><input value={title} placeholder="After the dinner" onChange={e => setTitle(e.target.value)} /></label>
          <label className="field"><span>Campaign</span><SearchSelect value={campaign} options={campaigns} onChange={setCampaign} placeholder="Optional, narrows the donors…" /></label>
          <label className="field"><span>Due</span><input type="date" value={due} onChange={e => setDue(e.target.value)} /><DateNote date={due} /></label>
          {isAdmin && <label className="field"><span>For fundraiser</span><SearchSelect value={owner} options={managers} onChange={setOwner} placeholder="Optional…" /></label>}
        </div>
        <label className="field"><span>Donors ({picked.size} chosen) · <button type="button" className="link" onClick={() => setAddingDonor(true)}>+ New donor</button></span>
          <input value={search} placeholder="Search donors…" onChange={e => setSearch(e.target.value)} /></label>
        {addingDonor && (
          <NewDonorDialog name={search} onClose={() => setAddingDonor(false)} onSaved={async row => {
            setAddingDonor(false);
            setDonors(await donorOptions());
            setPicked(p => new Set(p).add(String(row.id)));
            setSearch('');
          }} />
        )}
        <div className="pick-list">
          {shown.map(d => (
            <label className="inline-check" key={d.value}><input type="checkbox" checked={picked.has(d.value)} onChange={() => toggle(d.value)} /> {d.label}</label>
          ))}
          {shown.length === 0 && <p className="muted small">No donors found.</p>}
        </div>
        {error && <div className="error">{error}</div>}
        <div className="form-actions">
          <div className="spacer" />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={!title.trim() || picked.size === 0} onClick={save}>Create call list</button>
        </div>
      </div></div>
    </div>,
    document.body,
  );
}

const escapeHtml = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

function CallListDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { isAdmin, profile } = useAuth();
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const q = useQuery(async () => {
    const [t, i] = await Promise.all([
      supabase.from('tasks').select('*, owner:managers!tasks_owner_fkey(full_name)').eq('id', id).maybeSingle(),
      supabase.from('task_call_items').select('*, donors(display_name, phone, email)').eq('task_id', id),
    ]);
    const items = ((i.data ?? []) as Row[]).sort((a, b) => String(a.donors?.display_name).localeCompare(String(b.donors?.display_name)));
    return { task: t.data as Row | null, items };
  }, [id, version]);
  const t = q.data?.task;
  const items = q.data?.items ?? [];
  const canWork = t && !(isAdmin && t.owner_manager_id && t.created_by !== profile?.email);

  async function save(i: Row, contacted: boolean, note: string) {
    setError(null);
    const { error: e } = await supabase.rpc('set_call_item', { p_item: i.id, p_contacted: contacted, p_note: note });
    if (e) return setError(e.message);
    setVersion(v => v + 1);
  }
  const csvRows = () => items.map(i => ({ donor: i.donors?.display_name, phone: i.donors?.phone, email: i.donors?.email, reached: i.contacted ? 'Yes' : '', note: i.note }));
  function print() {
    const w = window.open('', '_blank');
    if (!w) return setError('Your browser blocked the print window.');
    w.document.write(`<!doctype html><meta charset="utf-8"><title>${escapeHtml(t?.title)}</title>
      <style>body{font:13px sans-serif;margin:24px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #999;padding:6px 8px;text-align:left}td.box{width:24px}</style>
      <h2>${escapeHtml(t?.title)}</h2>
      <table><tr><th></th><th>Donor</th><th>Phone</th><th>Notes</th></tr>
      ${items.map(i => `<tr><td class="box">${i.contacted ? '&#10003;' : ''}</td><td>${escapeHtml(i.donors?.display_name)}</td><td>${escapeHtml(i.donors?.phone)}</td><td>${escapeHtml(i.note)}</td></tr>`).join('')}
      </table>`);
    w.document.close();
    w.print();
  }

  return (
    <Overlay onClose={onClose}>
      <div className="form-head">
        <h2>{t?.title ?? 'Call list'}</h2>
        <button type="button" className="icon-btn" title="Close" onClick={onClose}><X size={18} /></button>
      </div>
      <p className="muted small">
        {items.filter(i => i.contacted).length} of {items.length} reached
        {t?.due_date && ` · due ${t.due_date}`}
        {t?.owner?.full_name && ` · ${t.owner.full_name}`}
        {!canWork && t && ' · only the fundraiser can check these off'}
      </p>
      {error && <div className="error">{error}</div>}
      <div className="table-wrap dialog-table"><table className="grid">
        <thead><tr><th>Reached</th><th>Donor</th><th>Phone</th><th>Note</th></tr></thead>
        <tbody>
          {items.map(i => (
            <tr key={i.id}>
              <td><input type="checkbox" aria-label={`Reached ${i.donors?.display_name}`} disabled={!canWork} checked={i.contacted} onChange={e => save(i, e.target.checked, i.note ?? '')} /></td>
              <td>{i.donors?.display_name}</td>
              <td>{i.donors?.phone}</td>
              <td><input aria-label={`Note for ${i.donors?.display_name}`} disabled={!canWork} defaultValue={i.note ?? ''} placeholder="Left voicemail…" onBlur={e => { if (e.target.value !== (i.note ?? '')) save(i, i.contacted, e.target.value); }} /></td>
            </tr>
          ))}
        </tbody>
      </table></div>
      <div className="form-actions">
        <button type="button" className="btn" onClick={print}>Print</button>
        <button type="button" className="btn" onClick={() => download(`${t?.title ?? 'call-list'}.csv`, toCsv(csvRows(), [{ key: 'donor', label: 'Donor' }, { key: 'phone', label: 'Phone' }, { key: 'email', label: 'Email' }, { key: 'reached', label: 'Reached' }, { key: 'note', label: 'Note' }]))}>Export</button>
        {canWork && t?.status !== 'Done' && (
          <button type="button" className="btn primary" onClick={async () => {
            const { error: e } = await supabase.from('tasks').update({ status: 'Done' }).eq('id', id);
            if (e) return setError(e.message);
            onClose();
          }}>Mark list done</button>
        )}
      </div>
    </Overlay>
  );
}
