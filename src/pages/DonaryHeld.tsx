import { useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase, type Row } from '../lib/supabase';
import { dateTime, money } from '../lib/format';
import { useQuery } from '../lib/useQuery';

/** The organization setting: 'ignore' (the default) keeps held Donary cash and checks out of the way; 'review' lists them here. */
export const DONARY_CASH_CHECK_SETTING = 'donary_cash_check_mode';
export type DonaryCashCheckMode = 'ignore' | 'review';
export const readMode = (v: unknown): DonaryCashCheckMode => (v === 'review' ? 'review' : 'ignore');

/**
 * Transactions > Donary cash & checks (Shulim, 2026-11-25). Cash and check gifts from Donary arrive held: not counted in
 * totals, campaign progress, receipts or alerts. With the organization set to review them, they're listed here; Mark
 * delivered makes each one count. Set to ignore (the default), they stay out of the way and this page says how many.
 */
export function DonaryHeldPage() {
  const [version, setVersion] = useState(0);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const q = useQuery(async () => {
    const [{ data: s }, list] = await Promise.all([
      supabase.from('settings').select('value').eq('key', DONARY_CASH_CHECK_SETTING).maybeSingle(),
      supabase.from('transaction_list').select('id, created_at, amount, payment_method, check_number, donor_name, campaign_id, campaign_internal, campaign_external, collector_name, donary_id')
        .eq('status', 'held').not('donary_id', 'is', null).order('created_at', { ascending: false }).limit(500),
    ]);
    if (list.error) throw new Error(list.error.message);
    return { mode: readMode(s?.value), rows: (list.data ?? []) as Row[] };
  }, [version]);
  const rows = q.data?.rows ?? [];
  const total = rows.reduce((t, r) => t + Number(r.amount ?? 0), 0);

  async function deliver(ids: string[]) {
    if (!ids.length) return;
    setBusy(true); setError(null); setNote(null);
    const { data, error: e } = await supabase.rpc('mark_donary_delivered', { p_ids: ids });
    setBusy(false);
    if (e) return setError(e.message);
    setNote(`${data as number} marked delivered; ${data === 1 ? 'it counts' : 'they count'} from now on.`);
    setPicked([]);
    setVersion(v => v + 1);
  }

  return (
    <div className="pad">
      <h1>Donary cash &amp; checks</h1>
      <p className="muted">Cash and check gifts that come in from Donary aren't counted in totals, campaign progress, receipts or alerts until
        someone marks them delivered (the money reached the office).</p>
      {q.error && <div className="error">{q.error}</div>}
      {error && <div className="error">{error}</div>}
      {note && <div className="notice">{note}</div>}
      {q.data && q.data.mode === 'ignore' && (
        <div className="card">
          <p>This organization ignores them: {rows.length ? <><b>{rows.length}</b> held ({money(total)}), not counted.</> : 'none held right now.'}</p>
          <p className="muted small">To review them here and mark them delivered, choose <b>Flag them for review</b> under
            Donary cash and checks in <Link to="/organization">Organization settings</Link>.</p>
        </div>
      )}
      {q.data && q.data.mode === 'review' && (
        rows.length === 0 ? <div className="card"><p className="muted">Nothing waiting: no Donary cash or check gifts are held.</p></div> : (
          <div className="card">
            <div className="form-actions">
              <span><b>{rows.length}</b> held · {money(total)} · not counted</span>
              <div className="spacer" />
              <button type="button" className="btn primary" disabled={busy || !picked.length}
                onClick={() => confirm(`Mark ${picked.length} delivered? ${picked.length === 1 ? 'It' : 'They'} will count in totals and campaign progress.`) && void deliver(picked)}>
                {busy ? 'Marking…' : `Mark delivered${picked.length ? ` (${picked.length})` : ''}`}
              </button>
            </div>
            <table className="grid">
              <thead><tr>
                <th className="pick"><input type="checkbox" aria-label="Pick all" checked={picked.length === rows.length}
                  onChange={e => setPicked(e.target.checked ? rows.map(r => String(r.id)) : [])} /></th>
                <th>Date</th><th>Donor</th><th>Campaign</th><th>Method</th><th>Collected by</th><th className="right">Amount</th><th />
              </tr></thead>
              <tbody>
                {rows.map(r => {
                  const id = String(r.id);
                  return (
                    <tr key={id}>
                      <td className="pick"><input type="checkbox" aria-label={`Pick ${id}`} checked={picked.includes(id)}
                        onChange={e => setPicked(p => (e.target.checked ? [...p, id] : p.filter(x => x !== id)))} /></td>
                      <td>{dateTime(r.created_at)}</td>
                      <td>{r.donor_name ?? '—'}</td>
                      <td>{r.campaign_id ? <Link to={`/campaigns/${encodeURIComponent(r.campaign_id)}`}>{r.campaign_internal || r.campaign_external || r.campaign_id}</Link> : '—'}</td>
                      <td>{r.payment_method}{r.check_number ? ` #${r.check_number}` : ''}</td>
                      <td>{r.collector_name ?? '—'}</td>
                      <td className="right num">{money(r.amount)}</td>
                      <td><button type="button" className="btn small" disabled={busy} onClick={() => void deliver([id])}>Mark delivered</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {rows.length === 500 && <p className="muted small">Showing the newest 500.</p>}
          </div>
        )
      )}
    </div>
  );
}

/** Organization settings: what to do with Donary cash and check gifts. Saved as soon as it's changed. */
export function DonaryCashCheckSetting({ orgId }: { orgId: string }) {
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const q = useQuery(async () => {
    const { data } = await supabase.from('settings').select('value').eq('key', DONARY_CASH_CHECK_SETTING).maybeSingle();
    return readMode(data?.value);
  }, [orgId]);
  async function change(mode: DonaryCashCheckMode) {
    setSaved(false); setError(null);
    const { error: e } = await supabase.from('settings').upsert({ org_id: orgId, key: DONARY_CASH_CHECK_SETTING, value: mode }, { onConflict: 'org_id,key' });
    if (e) return setError(e.message);
    setSaved(true);
    void q.reload({ quiet: true });
  }
  return (
    <div className="settings-section card">
      <h3>Donary cash and checks</h3>
      <p className="muted small">Cash and check gifts from Donary only say a fundraiser wrote one down. They aren't counted in totals, campaign
        progress, receipts or alerts until marked delivered.</p>
      <label className="field"><span>When one comes in</span>
        <select value={q.data ?? 'ignore'} onChange={e => void change(e.target.value as DonaryCashCheckMode)} disabled={q.data == null}>
          <option value="ignore">Ignore them (not counted)</option>
          <option value="review">Flag them for review (listed under Transactions, not counted until marked delivered)</option>
        </select>
      </label>
      {saved && <p className="muted small">Saved.</p>}
      {error && <div className="error">{error}</div>}
      <p className="small"><Link to="/donations/donary-held">Donary cash &amp; checks</Link></p>
    </div>
  );
}
