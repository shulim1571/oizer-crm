import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { Plus, X } from 'lucide-react';
import DataTable, { type Column } from '../components/DataTable';
import SearchSelect from '../components/SearchSelect';
import { StatusPill } from '../components/Pill';
import { useAuth } from '../lib/auth';
import { dateTime, money } from '../lib/format';
import { campaignOptions, clearLookups, managerOptions, type Option } from '../lib/lookups';
import { fetchAll, supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';
import { Overlay } from './Pledges';

const STATUS: Record<string, string> = {
  pending: 'Pending', changes_requested: 'Changes requested', approved: 'Approved', rejected: 'Rejected', withdrawn: 'Withdrawn',
};

const columns: Column[] = [
  { key: 'name', label: 'Campaign', width: 220 },
  { key: 'status', label: 'Status', value: r => STATUS[r.status], render: r => <StatusPill value={STATUS[r.status]} /> },
  { key: 'requester', label: 'Fundraiser', value: r => r.managers?.full_name ?? r.requested_by_email, width: 150 },
  { key: 'goal', label: 'Goal', render: r => r.goal != null && money(r.goal), align: 'right' },
  { key: 'parent_campaign_id', label: 'Under' },
  { key: 'admin_note', label: 'Admin note', width: 200 },
  { key: 'created_at', label: 'Submitted', render: r => dateTime(r.created_at) },
];

export default function RequestsPage() {
  const { isAdmin } = useAuth();
  const [version, setVersion] = useState(0);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery(
    () => fetchAll((a, b) => supabase.from('campaign_requests').select('*, managers(full_name)').order('created_at', { ascending: false }).range(a, b) as never),
    [version],
  );
  return (
    <section className="view">
      <DataTable
        title={isAdmin ? 'Campaign Requests' : 'My Campaign Requests'}
        rows={(q.data as Row[]) ?? []}
        loading={q.loading}
        error={q.error}
        columns={columns}
        exportName="campaign-requests"
        onOpen={r => setOpen(r.id)}
        actions={!isAdmin && <button className="btn primary" onClick={() => setAdding(true)}><Plus size={16} /> Request new campaign</button>}
      />
      {adding && <RequestForm onClose={() => setAdding(false)} onDone={() => { setAdding(false); setVersion(v => v + 1); }} />}
      {open && <RequestDialog id={open} onClose={() => setOpen(null)} onChanged={() => setVersion(v => v + 1)} />}
    </section>
  );
}

/** New, or a resubmission when one comes back for changes. */
function RequestForm({ record, onClose, onDone }: { record?: Row; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState<string>(record?.name ?? '');
  const [description, setDescription] = useState<string>(record?.description ?? '');
  const [goal, setGoal] = useState(record?.goal != null ? String(record.goal) : '');
  const [notes, setNotes] = useState<string>(record?.notes ?? '');
  const [parent, setParent] = useState<string | null>(record?.parent_campaign_id ?? null);
  const [options, setOptions] = useState<Option[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { campaignOptions().then(setOptions); }, []);

  async function save() {
    setBusy(true);
    setError(null);
    const goalValue = goal ? Number(goal) : null;
    const { error: e } = record
      ? await supabase.rpc('resubmit_campaign_request', { p_id: record.id, p_name: name, p_description: description, p_goal: goalValue, p_notes: notes })
      : await supabase.rpc('submit_campaign_request', { p_name: name, p_description: description, p_goal: goalValue, p_notes: notes, p_parent: parent });
    setBusy(false);
    if (e) return setError(e.message);
    onDone();
  }

  return createPortal(
    <div className="modal-back" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="modal"><div className="record-form">
        <div className="form-head"><h2>{record ? 'Change and resubmit' : 'Request a new campaign'}</h2></div>
        {record?.admin_note && <div className="notice">Admin's note: {record.admin_note}</div>}
        <label className="field"><span>Campaign name *</span><input value={name} onChange={e => setName(e.target.value)} /></label>
        <label className="field"><span>Description</span><textarea rows={3} value={description} onChange={e => setDescription(e.target.value)} /></label>
        <label className="field"><span>Fundraising goal</span><input type="number" step="0.01" min="0" value={goal} onChange={e => setGoal(e.target.value)} /></label>
        {!record && (
          <label className="field"><span>As a sub-campaign of</span>
            <SearchSelect value={parent} options={options} onChange={setParent} placeholder="Optional, one of your campaigns…" />
          </label>
        )}
        <label className="field"><span>Notes for the admin</span><textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)} /></label>
        {!record && <p className="muted small">Once sent, a request can't be edited. You can withdraw it and send a new one.</p>}
        {error && <div className="error">{error}</div>}
        <div className="form-actions">
          <div className="spacer" />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy || !name.trim()} onClick={save}>{record ? 'Resubmit' : 'Send request'}</button>
        </div>
      </div></div>
    </div>,
    document.body,
  );
}

function RequestDialog({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { isAdmin } = useAuth();
  const [version, setVersion] = useState(0);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const q = useQuery(async () => (await supabase.from('campaign_requests').select('*, managers(full_name)').eq('id', id).maybeSingle()).data as Row | null, [id, version]);
  const r = q.data;
  const changed = () => { setEditing(false); setVersion(v => v + 1); onChanged(); };

  async function withdraw() {
    if (!confirm('Withdraw this request?')) return;
    const { error: e } = await supabase.rpc('withdraw_campaign_request', { p_id: id });
    if (e) return setError(e.message);
    changed();
  }

  return (
    <Overlay onClose={onClose}>
      {!r ? <p className="muted">Loading…</p> : (
        <>
          <div className="form-head">
            <h2>{r.name} <StatusPill value={STATUS[r.status]} /></h2>
            <button type="button" className="icon-btn" title="Close" onClick={onClose}><X size={18} /></button>
          </div>
          <RequestFacts r={r} />
          {error && <div className="error">{error}</div>}
          {isAdmin && r.status === 'pending' && <RequestDecision id={id} onDone={changed} />}
          {!isAdmin && (r.status === 'pending' || r.status === 'changes_requested') && (
            <div className="donation-actions">
              {r.status === 'changes_requested' && <button type="button" className="btn primary" onClick={() => setEditing(true)}>Change and resubmit</button>}
              <button type="button" className="btn danger" onClick={withdraw}>Withdraw</button>
            </div>
          )}
          {editing && <RequestForm record={r} onClose={() => setEditing(false)} onDone={changed} />}
        </>
      )}
    </Overlay>
  );
}

function RequestFacts({ r }: { r: Row }) {
  return (
    <dl className="record-facts">
      <dt>Fundraiser</dt><dd>{r.managers?.full_name ?? r.requested_by_email}</dd>
      {r.parent_campaign_id && <><dt>Sub-campaign of</dt><dd>#{r.parent_campaign_id}</dd></>}
      {r.goal != null && <><dt>Goal</dt><dd>{money(r.goal)}</dd></>}
      {r.description && <><dt>Description</dt><dd className="pre-line">{r.description}</dd></>}
      {r.notes && <><dt>Notes</dt><dd className="pre-line">{r.notes}</dd></>}
      <dt>Submitted</dt><dd>{dateTime(r.created_at)}{r.resubmitted_at && ` · resubmitted ${dateTime(r.resubmitted_at)}`}</dd>
      {r.admin_note && <><dt>Admin note</dt><dd className="pre-line">{r.admin_note}</dd></>}
      {r.decided_by && <><dt>Decided by</dt><dd>{r.decided_by} · {dateTime(r.decided_at)}</dd></>}
      {r.campaign_id && <><dt>Campaign</dt><dd><Link to={`/campaigns/${encodeURIComponent(r.campaign_id)}`}>#{r.campaign_id}</Link></dd></>}
    </dl>
  );
}

/** Approve (with edits and the team, in one step), reject, or send back. */
export function RequestDecision({ id, onDone }: { id: string; onDone: (action: string) => void }) {
  const q = useQuery(async () => (await supabase.from('campaign_requests').select('*, managers(full_name)').eq('id', id).maybeSingle()).data as Row | null, [id]);
  const r = q.data;
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [primary, setPrimary] = useState<string | null>(null);
  const [secondaries, setSecondaries] = useState<string[]>([]);
  const [mode, setMode] = useState('shared');
  const [note, setNote] = useState('');
  const [managers, setManagers] = useState<Option[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { managerOptions().then(setManagers); }, []);
  useEffect(() => {
    if (!r) return;
    setName(r.name);
    setGoal(r.goal != null ? String(r.goal) : '');
    setPrimary(r.manager_id);
  }, [r]);

  async function finish(call: PromiseLike<{ error: { message: string } | null }>, action: string) {
    setError(null);
    const { error: e } = await call;
    if (e) return setError(e.message);
    clearLookups();
    onDone(action);
  }

  if (!r) return null;
  return (
    <div className="panel-box">
      {r.description && <p className="pre-line">{r.description}</p>}
      {r.notes && <p className="muted pre-line">{r.notes}</p>}
      <div className="fields">
        <label className="field"><span>Campaign name *</span><input value={name} onChange={e => setName(e.target.value)} /></label>
        <label className="field"><span>Goal</span><input type="number" step="0.01" min="0" value={goal} onChange={e => setGoal(e.target.value)} /></label>
        <label className="field"><span>Primary fundraiser</span><SearchSelect value={primary} options={managers} onChange={setPrimary} placeholder="Fundraiser…" /></label>
        <label className="field"><span>Secondary fundraisers</span>
          <select multiple value={secondaries} onChange={e => setSecondaries([...e.target.selectedOptions].map(o => o.value))}>
            {managers.filter(m => m.value !== primary).map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </label>
        {r.parent_campaign_id && (
          <label className="field"><span>Create as</span>
            <select value={mode} onChange={e => setMode(e.target.value)}>
              <option value="shared">Team (raises into the parent's balance)</option>
              <option value="independent">Sub-campaign (its own balance)</option>
            </select>
          </label>
        )}
      </div>
      <label className="field"><span>Note to the fundraiser</span><textarea rows={2} value={note} onChange={e => setNote(e.target.value)} /></label>
      {error && <div className="error">{error}</div>}
      <div className="form-actions">
        <button type="button" className="btn danger" onClick={() => finish(supabase.rpc('decide_campaign_request', { p_id: id, p_status: 'rejected', p_note: note || null }), 'rejected')}>Reject</button>
        <button type="button" className="btn" onClick={() => finish(supabase.rpc('decide_campaign_request', { p_id: id, p_status: 'changes_requested', p_note: note || null }), 'changes requested')}>Request changes</button>
        <div className="spacer" />
        <button type="button" className="btn primary" disabled={!name.trim()} onClick={() => finish(supabase.rpc('approve_campaign_request', {
          p_id: id, p_name: name, p_goal: goal ? Number(goal) : null, p_primary: primary, p_secondaries: secondaries, p_note: note || null, p_mode: mode,
        }), 'approved')}>Approve and create</button>
      </div>
    </div>
  );
}

/** A primary fundraiser asks for someone to join the campaign. An admin decides on the Task Sheet. */
export function RequestTeamDialog({ campaignId, onClose }: { campaignId: string; onClose: () => void }) {
  const [role, setRole] = useState('secondary');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function send() {
    setError(null);
    const { error: e } = await supabase.rpc('request_team_member', { p_campaign: campaignId, p_role: role, p_name: name, p_email: email, p_phone: phone });
    if (e) return setError(e.message);
    setSent(true);
  }

  return createPortal(
    <div className="modal-back" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="modal"><div className="record-form">
        <div className="form-head"><h2>Request a team member</h2></div>
        {sent ? <div className="notice">Sent. An admin will review it.</div> : (
          <>
            <label className="field"><span>Role</span>
              <select value={role} onChange={e => setRole(e.target.value)}>
                <option value="secondary">Secondary fundraiser</option>
                <option value="guest">Community guest (read only)</option>
              </select>
            </label>
            <label className="field"><span>Name</span><input value={name} onChange={e => setName(e.target.value)} /></label>
            <label className="field"><span>Email</span><input type="email" value={email} onChange={e => setEmail(e.target.value)} /></label>
            <label className="field"><span>Phone</span><input value={phone} onChange={e => setPhone(e.target.value)} /></label>
          </>
        )}
        {error && <div className="error">{error}</div>}
        <div className="form-actions">
          <div className="spacer" />
          <button type="button" className="btn" onClick={onClose}>{sent ? 'Close' : 'Cancel'}</button>
          {!sent && <button type="button" className="btn primary" onClick={send}>Send request</button>}
        </div>
      </div></div>
    </div>,
    document.body,
  );
}
