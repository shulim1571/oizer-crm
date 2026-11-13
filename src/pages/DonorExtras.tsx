import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Plus, Search } from 'lucide-react';
import DataTable from '../components/DataTable';
import { StatusPill } from '../components/Pill';
import { useAuth } from '../lib/auth';
import { localToday, dateTime, money } from '../lib/format';
import { clearLookups } from '../lib/lookups';
import { supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';
import { PLEDGE_STATUS, PledgeDialog } from './Pledges';

const METHODS = ['Call', 'Email', 'SMS', 'In Person'];
const OUTCOMES = ['Reached', 'Voicemail', 'No Answer', 'Replied', 'Meeting Scheduled', 'Other'];

/** Live search of the whole organization's donors. Choosing one adds them to a fundraiser's list. */
export function DonorLookup() {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (q.trim().length < 2) return setResults([]);
    const timer = setTimeout(() => {
      supabase.rpc('lookup_donors', { p_q: q }).then(({ data, error: e }) => {
        if (e) return setError(e.message);
        setError(null);
        setResults((data ?? []) as Row[]);
      });
    }, 200);
    return () => clearTimeout(timer);
  }, [q]);

  async function open(d: Row) {
    if (!d.on_my_list) {
      const { error: e } = await supabase.rpc('link_donor', { p_donor: d.id });
      if (e) return setError(e.message);
    }
    nav(`/donors/${encodeURIComponent(d.id)}`);
  }

  return (
    <div className="lookup">
      <label className="lookup-box">
        <Search size={18} />
        <input aria-label="Look up a donor" value={q} placeholder="Look up a donor by name, phone or ID…" onChange={e => setQ(e.target.value)} />
      </label>
      {error && <div className="error">{error}</div>}
      {q.trim().length >= 2 && (
        <div className="lookup-results">
          {results.map(d => (
            <button type="button" key={d.id} onClick={() => open(d)}>
              <b>{d.display_name}</b>
              {d.yiddish_name && d.yiddish_name !== d.display_name && <span className="hebrew"> {d.yiddish_name}</span>}
              <span className="muted small"> {[d.phone, d.email].filter(Boolean).join(' · ') || `#${d.id}`}</span>
              {!d.on_my_list && <span className="muted small"> · add to my list</span>}
            </button>
          ))}
          {results.length === 0 && <p className="muted small">No donor found. Add them as new below if they aren't here.</p>}
        </div>
      )}
    </div>
  );
}

export function ContactLog({ donorId }: { donorId: string }) {
  const [version, setVersion] = useState(0);
  const [adding, setAdding] = useState(false);
  const [method, setMethod] = useState('Call');
  const [outcome, setOutcome] = useState('Reached');
  const [notes, setNotes] = useState('');
  const [date, setDate] = useState(localToday());
  const [error, setError] = useState<string | null>(null);
  const q = useQuery(
    async () => (await supabase.from('donor_contacts').select('*').eq('donor_id', donorId).order('contact_date', { ascending: false }).order('created_at', { ascending: false })).data ?? [],
    [donorId, version],
  );

  async function save() {
    setError(null);
    const { error: e } = await supabase.rpc('add_donor_contact', { p_donor: donorId, p_method: method, p_outcome: outcome, p_notes: notes, p_date: date });
    if (e) return setError(e.message);
    setAdding(false);
    setNotes('');
    setVersion(v => v + 1);
  }

  return (
    <div className="card">
      <div className="dialog-section"><h3>Contact log</h3>
        {!adding && <button type="button" className="link" onClick={() => setAdding(true)}><Plus size={13} /> Add entry</button>}
      </div>
      {adding && (
        <div className="panel-box">
          <div className="fields">
            <label className="field"><span>Date</span><input type="date" value={date} onChange={e => setDate(e.target.value)} /></label>
            <label className="field"><span>Method</span><select value={method} onChange={e => setMethod(e.target.value)}>{METHODS.map(m => <option key={m}>{m}</option>)}</select></label>
            <label className="field"><span>Outcome</span><select value={outcome} onChange={e => setOutcome(e.target.value)}>{OUTCOMES.map(m => <option key={m}>{m}</option>)}</select></label>
          </div>
          <label className="field"><span>Notes</span><textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)} /></label>
          <p className="muted small">Entries are permanent. To fix one, add a correction.</p>
          {error && <div className="error">{error}</div>}
          <div className="form-actions">
            <div className="spacer" />
            <button type="button" className="btn" onClick={() => setAdding(false)}>Cancel</button>
            <button type="button" className="btn primary" onClick={save}>Save entry</button>
          </div>
        </div>
      )}
      <ul className="plain">
        {((q.data as Row[]) ?? []).map(c => (
          <li key={c.id}>
            <b>{c.contact_date}</b> · {c.method} · {c.outcome}
            <span className="muted small"> · {c.created_by}</span>
            {c.notes && <div className="pre-line">{c.notes}</div>}
          </li>
        ))}
        {!q.loading && !(q.data as Row[] | null)?.length && <li className="muted">No contact yet</li>}
      </ul>
    </div>
  );
}

export function DonorPledges({ donorId, onChanged }: { donorId: string; onChanged: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const q = useQuery(
    async () => (await supabase.from('pledge_list').select('*').eq('donor_id', donorId).order('date_pledged', { ascending: false })).data ?? [],
    [donorId, version],
  );
  const rows = (q.data as Row[]) ?? [];
  return (
    <div className="card">
      <h3>Pledges</h3>
      <ul className="plain">
        {rows.map(p => (
          <li key={p.id}>
            <button type="button" className="link" onClick={() => setOpen(p.id)}>{p.reference}</button> {money(p.balance)} left of {money(p.amount)} <StatusPill value={PLEDGE_STATUS[p.status]} />
          </li>
        ))}
        {!q.loading && rows.length === 0 && <li className="muted">None</li>}
      </ul>
      {open && <PledgeDialog id={open} onClose={() => setOpen(null)} onChanged={() => { setVersion(v => v + 1); onChanged(); }} />}
    </div>
  );
}

/** Same name or phone. An admin merges them, or says they're different people. */
export function DuplicatesPage() {
  const [version, setVersion] = useState(0);
  const [group, setGroup] = useState<Row | null>(null);
  const q = useQuery(async () => {
    const { data, error } = await supabase.from('donor_duplicates').select('*').order('donor_count', { ascending: false }).order('match_key');
    if (error) throw new Error(error.message);
    return (data ?? []) as Row[];
  }, [version]);
  return (
    <section className="view">
      <DataTable
        title="Possible duplicate donors"
        rows={q.data ?? []}
        loading={q.loading}
        error={q.error}
        exportName="possible-duplicate-donors"
        onOpen={setGroup}
        columns={[
          { key: 'reason', label: 'Why' },
          { key: 'donor_count', label: 'Donors', align: 'right' },
          { key: 'names', label: 'Who', width: 420, value: r => (r.donors as Row[]).map(d => `${d.name} (#${d.id})${d.phone ? ` ${d.phone}` : ''}`).join(' · ') },
        ]}
      />
      {group && <MergeDialog group={group} onClose={() => setGroup(null)} onDone={() => { setGroup(null); clearLookups(); setVersion(v => v + 1); }} />}
    </section>
  );
}

function MergeDialog({ group, onClose, onDone }: { group: Row; onClose: () => void; onDone: () => void }) {
  const donors = group.donors as Row[];
  const [keep, setKeep] = useState<string>(donors[0].id);
  const [absorb, setAbsorb] = useState<string[]>(donors.length === 2 ? [donors[1].id] : []);
  const [error, setError] = useState<string | null>(null);
  const { profile } = useAuth();
  const totals = useQuery(
    async () => (await supabase.from('donor_summary').select('id, total_given, gift_count, last_gift_at').in('id', donors.map(d => d.id))).data ?? [],
    [group.match_key],
  );
  const facts = (id: string) => (totals.data as Row[] | null)?.find(t => t.id === id);

  async function merge() {
    const names = donors.filter(d => absorb.includes(d.id)).map(d => d.name).join(', ');
    if (!confirm(`Merge ${names} into #${keep}? Their donations, pledges and contact log move over. This can't be undone.`)) return;
    setError(null);
    for (const id of absorb) {
      const { error: e } = await supabase.rpc('merge_donors', { p_keep: keep, p_absorb: id });
      if (e) return setError(e.message);
    }
    onDone();
  }
  async function dismiss() {
    const { error: e } = await supabase.rpc('dismiss_donor_duplicate', { p_key: group.match_key });
    if (e) return setError(e.message);
    onDone();
  }

  return createPortal(
    <div className="modal-back" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-wide"><div className="record-form">
        <div className="form-head"><h2>{group.reason}</h2></div>
        <p className="muted small">Choose whose name and details to keep. Blanks fill in from the other. Signed in as {profile?.email}; the merge is logged and can't be undone.</p>
        <div className="table-wrap dialog-table"><table className="grid">
          <thead><tr><th>Keep</th><th>Merge in</th><th>Donor</th><th>Phone</th><th>Email</th><th>Given</th><th>Gifts</th><th>Last gift</th></tr></thead>
          <tbody>
            {donors.map(d => (
              <tr key={d.id}>
                <td><input type="radio" name="keep" aria-label={`Keep ${d.name}`} checked={keep === d.id} onChange={() => { setKeep(d.id); setAbsorb(a => a.filter(x => x !== d.id)); }} /></td>
                <td><input type="checkbox" aria-label={`Merge in ${d.name}`} disabled={keep === d.id} checked={absorb.includes(d.id)} onChange={e => setAbsorb(a => (e.target.checked ? [...a, d.id] : a.filter(x => x !== d.id)))} /></td>
                <td>{d.name} <span className="id-tag">{d.id}</span></td>
                <td>{d.phone}</td>
                <td>{d.email}</td>
                <td>{money(facts(d.id)?.total_given ?? 0)}</td>
                <td>{facts(d.id)?.gift_count ?? 0}</td>
                <td>{dateTime(facts(d.id)?.last_gift_at)}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
        {error && <div className="error">{error}</div>}
        <div className="form-actions">
          <button type="button" className="btn" onClick={dismiss}>Not duplicates</button>
          <div className="spacer" />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn danger" disabled={absorb.length === 0} onClick={merge}>Merge</button>
        </div>
      </div></div>
    </div>,
    document.body,
  );
}
