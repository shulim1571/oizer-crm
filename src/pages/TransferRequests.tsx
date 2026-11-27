import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { Pill } from '../components/Pill';
import SearchSelect from '../components/SearchSelect';
import { campLabel } from '../components/CrudPage';
import { dateTime, money } from '../lib/format';
import { fetchAll, supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';
import { Overlay } from './Pledges';

/*
 * Transfer requests (Moshe Henig, 2026-11-15): a fundraiser asks to move money between campaigns where they are the
 * primary fundraiser; an admin approves or rejects it on the Task Sheet, and only an approval makes the transfer.
 */

/** The fundraiser's request, from this campaign to another of theirs. */
export function RequestTransferDialog({ campaignId, onClose, onSent }: { campaignId: string; onClose: () => void; onSent: () => void }) {
  const [mine, setMine] = useState<Row[]>([]);
  const [to, setTo] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void (async () => {
      const { data: me } = await supabase.rpc('my_manager_ids');
      const ids = (me ?? []) as string[];
      const rows = await fetchAll((a, b) => supabase.from('campaign_summary').select('id, internal_name, campaign_name, external_name, balance, manager_id')
        .eq('status', 'active').eq('balance_mode', 'independent').in('manager_id', ids.length ? ids : ['(none)']).order('id').range(a, b) as never);
      setMine(rows as Row[]);
    })();
  }, []);
  const from = mine.find(c => c.id === campaignId);
  async function send() {
    setError(null); setBusy(true);
    const { error: e } = await supabase.rpc('request_transfer', { p_from: campaignId, p_to: to, p_amount: Number(amount), p_description: memo || null });
    setBusy(false);
    if (e) return setError(e.message);
    onSent();
  }
  return (
    <Overlay onClose={onClose} size="medium">
      <div className="form-head"><h2>Request a transfer</h2><button type="button" className="icon-btn" title="Close" onClick={onClose}><X size={20} /></button></div>
      <p className="muted small">Ask the office to move money from this campaign to another of yours. Nothing moves until an admin approves it.</p>
      <dl className="record-facts">
        <dt>From</dt><dd>{from ? campLabel(from) : campaignId}{from && <span className="muted small"> · balance {money(from.balance)}</span>}</dd>
      </dl>
      <label className="field"><span>To *</span>
        <SearchSelect value={to} options={mine.filter(c => c.id !== campaignId).map(c => ({ value: c.id, label: campLabel(c) }))} onChange={setTo} placeholder="One of your campaigns…" /></label>
      <label className="field"><span>Amount *</span><input type="number" min="0.01" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} /></label>
      <label className="field"><span>Reason</span><input value={memo} onChange={e => setMemo(e.target.value)} placeholder="Optional, for the office" /></label>
      {error && <div className="error">{error}</div>}
      <div className="form-actions"><div className="spacer" />
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={busy || !to || !(Number(amount) > 0)} onClick={() => void send()}>{busy ? 'Sending…' : 'Send request'}</button></div>
    </Overlay>
  );
}

const STATUS: Record<string, { label: string; tone: 'amber' | 'green' | 'red' | '' }> = {
  pending: { label: 'Waiting for the office', tone: 'amber' }, approved: { label: 'Approved', tone: 'green' },
  rejected: { label: 'Rejected', tone: 'red' }, withdrawn: { label: 'Withdrawn', tone: '' },
};

/** The fundraiser's own transfer requests touching this campaign, with Withdraw while waiting. */
export function MyTransferRequests({ campaignId, version }: { campaignId: string; version: number }) {
  const [v, setV] = useState(0);
  const q = useQuery(async () => (await supabase.from('transfer_requests').select('*')
    .or(`from_campaign_id.eq.${campaignId},to_campaign_id.eq.${campaignId}`).order('created_at', { ascending: false }).limit(20)).data as Row[] ?? [], [campaignId, version, v], { live: ['transfers'] });
  const rows = (q.data as Row[]) ?? [];
  if (!rows.length) return null;
  async function withdraw(r: Row) {
    if (!confirm('Withdraw this transfer request?')) return;
    const { error } = await supabase.rpc('withdraw_transfer_request', { p_id: r.id });
    if (error) return alert(error.message);
    setV(x => x + 1);
  }
  return (
    <div className="panel-box">
      <h2>My transfer requests</h2>
      <table className="mini"><thead><tr><th>Sent</th><th>From → To</th><th className="right">Amount</th><th>Status</th><th /></tr></thead><tbody>
        {rows.map(r => (
          <tr key={r.id}>
            <td>{dateTime(r.created_at)}</td><td>{r.from_campaign_id} → {r.to_campaign_id}{r.description ? <div className="muted small">{r.description}</div> : null}</td>
            <td className="right num">{money(r.amount)}</td>
            <td><Pill tone={STATUS[r.status]?.tone ?? ''}>{STATUS[r.status]?.label ?? r.status}</Pill>{r.admin_note && <div className="muted small">{r.admin_note}</div>}</td>
            <td className="right">{r.status === 'pending' && <button type="button" className="link" onClick={() => void withdraw(r)}>Withdraw</button>}</td>
          </tr>
        ))}
      </tbody></table>
    </div>
  );
}

/** The admin's decision, from the Task Sheet. */
export function DecideTransferRequest({ requestId, onDone }: { requestId: string; onDone: (action: string, note: string | null) => void }) {
  const q = useQuery(async () => {
    const { data: r } = await supabase.from('transfer_requests').select('*').eq('id', requestId).maybeSingle();
    if (!r) return null;
    const { data: camps } = await supabase.from('campaign_summary').select('id, internal_name, campaign_name, external_name, balance').in('id', [r.from_campaign_id, r.to_campaign_id]);
    return { r: r as Row, camps: (camps ?? []) as Row[] };
  }, [requestId]);
  const [note, setNote] = useState('');
  const [cross, setCross] = useState(false);
  const [needCross, setNeedCross] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const d = q.data as { r: Row; camps: Row[] } | null;
  if (!d) return q.loading ? null : <p className="muted">This request is no longer on file.</p>;
  const camp = (id: string) => d.camps.find(c => c.id === id);
  async function decide(approve: boolean) {
    if (!approve && !note.trim() && !confirm('Reject without a note to the fundraiser?')) return;
    setError(null); setBusy(true);
    const { error: e } = await supabase.rpc('decide_transfer_request', { p_id: requestId, p_approve: approve, p_note: note || null, p_cross: cross });
    setBusy(false);
    if (e) { if (/different bank accounts/.test(e.message)) setNeedCross(true); return setError(e.message); }
    onDone(approve ? 'approved' : 'rejected', note || null);
  }
  const from = camp(d.r.from_campaign_id);
  const short = from ? Number(d.r.amount) - Number(from.balance) : 0;
  return (
    <div className="panel-box">
      <dl className="record-facts">
        <dt>From</dt><dd>{from ? campLabel(from) : d.r.from_campaign_id}{from && <span className="muted small"> · balance {money(from.balance)}</span>}</dd>
        <dt>To</dt><dd>{camp(d.r.to_campaign_id) ? campLabel(camp(d.r.to_campaign_id)) : d.r.to_campaign_id}</dd>
        <dt>Amount</dt><dd>{money(d.r.amount)}</dd>
        <dt>Asked by</dt><dd>{d.r.requested_by}</dd>
        {d.r.description && <><dt>Reason</dt><dd>{d.r.description}</dd></>}
      </dl>
      {short > 0 && <div className="error">This is {money(short)} more than the source campaign's balance.</div>}
      <label className="field"><span>Note to the fundraiser</span><input value={note} onChange={e => setNote(e.target.value)} placeholder="Optional" /></label>
      {needCross && <label className="inline-check"><input type="checkbox" checked={cross} onChange={e => setCross(e.target.checked)} /> These campaigns are on different bank accounts: make it a cross-account transfer</label>}
      {error && <div className="error">{error}</div>}
      <div className="form-actions">
        <button type="button" className="btn danger" disabled={busy} onClick={() => void decide(false)}>Reject</button>
        <div className="spacer" />
        <button type="button" className="btn primary" disabled={busy || (needCross && !cross)} onClick={() => void decide(true)}>Approve and transfer</button>
      </div>
    </div>
  );
}
