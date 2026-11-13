import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, X } from 'lucide-react';
import DataTable from '../components/DataTable';
import RecordForm from '../components/RecordForm';
import SearchSelect from '../components/SearchSelect';
import { Pill } from '../components/Pill';
import { useAuth } from '../lib/auth';
import { dateTime, money } from '../lib/format';
import { clearLookups, payeeOptions, type Option } from '../lib/lookups';
import { payeeFields } from '../lib/schemas';
import { fetchAll, supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';
import { Overlay } from './Pledges';
import { PayoutStatusPill, payoutStatus } from './Payouts';

/** Every payee, with totals from the payouts the viewer can see. Doubles as the payee report. */
export function PayeesPage() {
  const { isAdmin } = useAuth();
  const [version, setVersion] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const q = useQuery(
    () => fetchAll((a, b) => supabase.from('payee_summary').select('*').order('total_paid', { ascending: false }).range(a, b) as never),
    [version],
  );
  const refresh = () => { clearLookups(); setVersion(v => v + 1); };
  return (
    <section className="view">
      <DataTable
        title="Payees"
        subtitle={isAdmin ? 'Everyone the organization has paid.' : 'People and businesses paid from your campaigns, with your campaigns\' totals.'}
        rows={(q.data as Row[]) ?? []}
        loading={q.loading}
        error={q.error}
        exportName="payee-report"
        onOpen={r => setOpen(r.id)}
        columns={[
          { key: 'name', label: 'Payee', width: 200, render: r => <>{r.name}{r.do_not_pay && <> <Pill tone="red">Do Not Pay</Pill></>}</> },
          { key: 'id', label: 'ID', render: r => <span className="id-tag">{r.id}</span> },
          { key: 'phone', label: 'Phone' },
          { key: 'email', label: 'Email' },
          { key: 'total_paid', label: 'Lifetime paid', render: r => money(r.total_paid), align: 'right' },
          { key: 'payout_count', label: 'Payouts', align: 'right' },
          { key: 'campaigns', label: 'Campaigns', value: r => (r.campaigns ?? []).join(', '), width: 160 },
          { key: 'methods', label: 'Methods', value: r => (r.methods ?? []).join(', ') },
          { key: 'last_payout_at', label: 'Last payout', render: r => dateTime(r.last_payout_at) },
          { key: 'preferred_method', label: 'Preferred method' },
        ]}
        actions={isAdmin && <button type="button" className="btn primary" onClick={() => setAdding(true)}><Plus size={15} /> New payee</button>}
      />
      {adding && <RecordForm table="payees" title="New payee" fields={payeeFields} onClose={() => setAdding(false)} onSaved={r => { setAdding(false); refresh(); setOpen(r.id); }} />}
      {open && <PayeeDialog id={open} onClose={() => setOpen(null)} onChanged={refresh} onMerged={keep => { refresh(); setOpen(keep); }} />}
    </section>
  );
}

function PayeeDialog({ id, onClose, onChanged, onMerged }: { id: string; onClose: () => void; onChanged: () => void; onMerged: (keep: string) => void }) {
  const { isAdmin } = useAuth();
  const [version, setVersion] = useState(0);
  const [tab, setTab] = useState<'payouts' | 'notes'>('payouts');
  const [editing, setEditing] = useState(false);
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const q = useQuery(async () => {
    const [summary, flag, notes] = await Promise.all([
      supabase.from('payee_summary').select('*').eq('id', id).maybeSingle(),
      isAdmin ? supabase.from('payee_flags').select('*').eq('payee_id', id).maybeSingle() : Promise.resolve({ data: null }),
      isAdmin ? supabase.from('payee_notes').select('*').eq('payee_id', id).order('created_at', { ascending: false }) : Promise.resolve({ data: [] }),
    ]);
    return { payee: summary.data as Row | null, flag: flag.data as Row | null, notes: (notes.data ?? []) as Row[] };
  }, [id, version]);
  const payouts = useQuery(
    () => fetchAll((a, b) => supabase.from('expenses').select('*, campaigns(internal_name, external_name)').eq('payee_id', id).order('created_at', { ascending: false }).range(a, b) as never),
    [id, version],
  );
  const p = q.data?.payee;
  const changed = () => { setVersion(v => v + 1); onChanged(); };

  async function flag(on: boolean) {
    setError(null);
    if (on) {
      const reason = prompt('Flag as Do Not Pay? Admins will see this whenever a payout to them is approved. Reason (optional):');
      if (reason === null) return;
      const { error: e } = await supabase.from('payee_flags').insert({ payee_id: id, reason: reason || null });
      if (e) return setError(e.message);
    } else {
      if (!confirm('Remove the Do Not Pay flag?')) return;
      const { error: e } = await supabase.from('payee_flags').delete().eq('payee_id', id);
      if (e) return setError(e.message);
    }
    changed();
  }

  if (!p) return null;
  return (
    <Overlay onClose={onClose}>
      <div className="form-head">
        <h2>{p.name} <span className="id-tag">{p.id}</span> {q.data?.flag && <Pill tone="red">Do Not Pay</Pill>}</h2>
        <button type="button" className="icon-btn" title="Close" onClick={onClose}><X size={18} /></button>
      </div>
      {q.data?.flag && <div className="error"><b>Do Not Pay.</b> {q.data.flag.reason ?? 'No reason given.'} · {q.data.flag.flagged_by}, {dateTime(q.data.flag.flagged_at)}</div>}
      <dl className="record-facts">
        {p.phone && <><dt>Phone</dt><dd>{p.phone}</dd></>}
        {p.email && <><dt>Email</dt><dd>{p.email}</dd></>}
        {p.address && <><dt>Address</dt><dd className="pre-line">{p.address}</dd></>}
        {p.preferred_method && <><dt>Prefers</dt><dd>{p.preferred_method}</dd></>}
        <dt>{isAdmin ? 'Lifetime paid' : 'Paid from your campaigns'}</dt><dd>{money(p.total_paid)} · {p.payout_count} payout{Number(p.payout_count) === 1 ? '' : 's'}</dd>
        {p.notes && <><dt>Notes</dt><dd className="pre-line">{p.notes}</dd></>}
      </dl>
      {error && <div className="error">{error}</div>}
      {isAdmin && (
        <div className="donation-actions">
          <button type="button" className="btn" onClick={() => setEditing(true)}>Edit</button>
          <button type="button" className={q.data?.flag ? 'btn' : 'btn danger'} onClick={() => flag(!q.data?.flag)}>{q.data?.flag ? 'Remove Do Not Pay' : 'Flag Do Not Pay'}</button>
          <button type="button" className="btn" onClick={() => setMerging(true)}>Merge with another payee</button>
        </div>
      )}
      {isAdmin && (
        <div className="tabs">
          <button className={tab === 'payouts' ? 'active' : ''} onClick={() => setTab('payouts')}>Payouts</button>
          <button className={tab === 'notes' ? 'active' : ''} onClick={() => setTab('notes')}>Rejection notes ({q.data?.notes.length ?? 0})</button>
        </div>
      )}
      {tab === 'payouts' ? (
        <div className="dialog-table">
          <DataTable
            title="Payout history"
            rows={(payouts.data as Row[]) ?? []}
            loading={payouts.loading}
            exportName={`payee-${id}-payouts`}
            plain
            columns={[
              { key: 'created_at', label: 'Date', render: r => dateTime(r.created_at) },
              { key: 'status', label: 'Status', value: payoutStatus, render: r => <PayoutStatusPill row={r} /> },
              { key: 'campaign', label: 'Campaign', render: r => <Link to={`/campaigns/${encodeURIComponent(r.campaign_id)}`}>{r.campaigns?.internal_name || r.campaigns?.external_name} - {r.campaign_id}</Link>, value: r => r.campaign_id },
              { key: 'amount', label: 'Amount', render: r => money(r.amount), align: 'right' },
              { key: 'method', label: 'Method' },
              { key: 'check_number', label: 'Check #' },
              { key: 'reference', label: 'Reference' },
            ]}
          />
        </div>
      ) : (
        <ul className="plain">
          {(q.data?.notes ?? []).map(n => <li key={n.id}><b>{dateTime(n.created_at)}</b> · {n.created_by}<div className="pre-line">{n.note}</div></li>)}
          {!q.data?.notes.length && <li className="muted">No rejected requests with a note.</li>}
        </ul>
      )}
      {editing && <RecordForm table="payees" title="Edit payee" fields={payeeFields} record={p} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); changed(); }} />}
      {merging && <MergePayees payee={p} onClose={() => setMerging(false)} onDone={keep => { setMerging(false); onMerged(keep); }} />}
    </Overlay>
  );
}

function MergePayees({ payee, onClose, onDone }: { payee: Row; onClose: () => void; onDone: (keep: string) => void }) {
  const [options, setOptions] = useState<Option[]>([]);
  const [other, setOther] = useState<string | null>(null);
  const [keepThis, setKeepThis] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { payeeOptions().then(all => setOptions(all.filter(o => o.value !== payee.id))); }, [payee.id]);
  const otherName = options.find(o => o.value === other)?.label ?? '';
  async function merge() {
    if (!other) return;
    const keep = keepThis ? payee.id : other;
    const absorb = keepThis ? other : payee.id;
    if (!confirm(`Merge for good? Payouts, requests and notes move to the payee you keep. This can't be undone.`)) return;
    const { error: e } = await supabase.rpc('merge_payees', { p_keep: keep, p_absorb: absorb });
    if (e) return setError(e.message);
    onDone(keep);
  }
  return (
    <Overlay onClose={onClose}>
      <div className="form-head"><h2>Merge payees</h2><button type="button" className="icon-btn" title="Close" onClick={onClose}><X size={18} /></button></div>
      <label className="field"><span>The same person as {payee.name}</span>
        <SearchSelect value={other} options={options} onChange={setOther} placeholder="Find the duplicate…" />
      </label>
      {other && (
        <div className="panel-box">
          <p className="muted small">Keep whose name and details? Blanks fill in from the other. A Do Not Pay flag on either one carries over.</p>
          <label className="inline-check"><input type="radio" name="keep" checked={keepThis} onChange={() => setKeepThis(true)} /> {payee.name} ({payee.id})</label><br />
          <label className="inline-check"><input type="radio" name="keep" checked={!keepThis} onChange={() => setKeepThis(false)} /> {otherName}</label>
        </div>
      )}
      {error && <div className="error">{error}</div>}
      <div className="form-actions"><div className="spacer" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn danger" disabled={!other} onClick={merge}>Merge</button></div>
    </Overlay>
  );
}
