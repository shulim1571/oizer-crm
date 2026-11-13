import { useEffect, useState } from 'react';
import { Link2, RefreshCw, Unlink } from 'lucide-react';
import { Pill } from '../components/Pill';
import { dateTime } from '../lib/format';
import { requestOrgId, supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';

// Plaid: link this bank account and pull its transactions in as bank lines. Sandbox (test institutions) since
// 2026-11-11; production, real banks, approved for Oizer by Shulim 2026-11-13. Which one is in use is the plaid
// function's PLAID_ENV setting; the keys live only in its secrets.

const LINK_SCRIPT = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';

// Plaid sends a new link's latest transactions first and up to a year of older ones over the following hours
// (Shulim, 2026-11-13). There is no Plaid webhook here, so the panel says to sync again later.
const HISTORY_NOTE = 'Plaid sends the most recent transactions first; older history keeps arriving from Plaid for a while, so sync again later.';
const RECENT_MS = 48 * 60 * 60 * 1000;

type PlaidLinkMeta = { institution?: { name?: string } | null; accounts?: { id: string; name?: string; mask?: string }[] };
declare global {
  interface Window {
    Plaid?: { create(o: { token: string; onSuccess: (publicToken: string, meta: PlaidLinkMeta) => void; onExit?: (err: unknown) => void }): { open(): void } };
  }
}

function loadLink(): Promise<void> {
  if (window.Plaid) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = LINK_SCRIPT;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Plaid Link didn\'t load. Check the connection and try again.'));
    document.head.appendChild(s);
  });
}

export async function callPlaid(body: Row) {
  const { data, error } = await supabase.functions.invoke('plaid', { body: { ...body, org: requestOrgId() } });
  if (error) throw new Error('The Plaid service didn\'t answer. Try again in a moment.');
  if (data?.error) throw new Error(data.error);
  return data as Row;
}

export default function PlaidPanel({ account, onSynced }: { account: string; onSynced: () => void }) {
  const status = useQuery(async () => (((await supabase.rpc('plaid_status')).data ?? []) as Row[]).find(r => r.account_id === account) ?? null, [account]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const s = status.data as Row | null | undefined;
  // Which Plaid environment the function uses (sandbox or production); unknown until it answers.
  const [env, setEnv] = useState<string | null>(null);
  useEffect(() => { callPlaid({ action: 'config', account }).then(r => setEnv(String(r.env)), () => setEnv(null)); }, [account]);
  const live = env === 'production';
  // How much history a new link asks Plaid for: the organization's setting, 30 to 730 days, default 365 (Shulim, 2026-11-13).
  const [days, setDays] = useState('');
  const [daysSaved, setDaysSaved] = useState<string | null>(null);
  useEffect(() => {
    supabase.from('settings').select('value').eq('key', 'plaid_days_requested').maybeSingle()
      .then(({ data }) => { const v = String(data?.value ?? ''); setDays(v || '365'); setDaysSaved(v || null); });
  }, []);
  async function saveDays() {
    setError(null); setMessage(null);
    const n = Number(days.trim());
    if (!Number.isInteger(n) || n < 30 || n > 730) return setError('Enter a whole number of days from 30 to 730.');
    const { error: e } = await supabase.from('settings').upsert({ org_id: requestOrgId(), key: 'plaid_days_requested', value: n }, { onConflict: 'org_id,key' });
    if (e) return setError(e.message);
    setDaysSaved(String(n));
    setMessage(`Saved: banks connected from now on ask Plaid for ${n} days of history.${s ? ' This account keeps its current link until it is disconnected and connected again.' : ''}`);
  }
  const otherEnv = s && env && s.environment && s.environment !== env;

  async function run(what: string, fn: () => Promise<void>) {
    setBusy(what); setError(null); setMessage(null);
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  }

  const connect = () => run('connect', async () => {
    const { link_token } = await callPlaid({ action: 'link_token', account });
    await loadLink();
    const { data: me } = await supabase.auth.getUser();
    await new Promise<void>((resolve, reject) => {
      window.Plaid!.create({
        token: link_token,
        onSuccess: (publicToken, meta) => {
          const pick = meta.accounts?.[0];
          callPlaid({ action: 'exchange', account, public_token: publicToken, institution: meta.institution?.name ?? null,
            account_pick: pick ? { id: pick.id, name: pick.name, mask: pick.mask } : null, by: me.user?.email ?? null })
            .then(() => resolve(), reject);
        },
        onExit: err => (err ? reject(new Error('Plaid Link closed before finishing.')) : resolve()),
      }).open();
    });
    status.reload();
    setMessage(`Linked. Use Sync now to bring in its transactions. ${HISTORY_NOTE}`);
  });

  const sync = () => run('sync', async () => {
    const r = await callPlaid({ action: 'sync', account });
    const fresh = s?.linked_at && Date.now() - new Date(s.linked_at).getTime() < RECENT_MS;
    setMessage(`Synced: ${r.added} new line${r.added === 1 ? '' : 's'}, ${r.updated} updated, ${r.removed} removed.${fresh ? ` ${HISTORY_NOTE}` : ''}`);
    status.reload();
    onSynced();
  });

  const unlink = () => {
    if (!confirm('Disconnect this bank account from Plaid? Lines already brought in stay.')) return;
    void run('unlink', async () => { await callPlaid({ action: 'unlink', account }); status.reload(); setMessage('Disconnected.'); });
  };

  return (
    <div className="panel-box plaid-panel">
      <h3><Link2 size={15} /> Plaid {env && (live ? <Pill tone="green">Production</Pill> : <Pill tone="amber">Sandbox</Pill>)} {s && <Pill tone="green">Linked</Pill>}</h3>
      {s ? (
        <p className="muted small">
          {s.institution_name ?? 'Bank'} · {s.account_name ?? 'Account'}{s.account_mask ? ` ••${s.account_mask}` : ''} · linked {dateTime(s.linked_at)}
          {s.last_synced_at ? <> · last synced {dateTime(s.last_synced_at)}</> : <> · not synced yet</>}
          {s.linked_at && Date.now() - new Date(s.linked_at).getTime() < RECENT_MS && <><br />{HISTORY_NOTE}</>}
        </p>
      ) : (
        live
          ? <p className="muted small">Connects the real bank account: in Plaid Link find the bank and sign in with its online-banking login. Plaid passes the transactions on; the bank login is never seen or kept here.</p>
          : <p className="muted small">Test institutions only: in Plaid Link pick any bank and sign in with <code>user_good</code> / <code>pass_good</code>. No real bank is connected.</p>
      )}
      {otherEnv && <div className="error">This account was linked in the Plaid {s!.environment}, and Plaid is now in {env}. Disconnect it, then connect the bank again.</div>}
      {s?.last_error && <div className="error">Last sync failed: {s.last_error}</div>}
      {message && <p className="muted">{message}</p>}
      {error && <div className="error">{error}</div>}
      <div className="plaid-days">
        <label>History to request when connecting{' '}
          <input type="number" min={30} max={730} step={1} value={days} onChange={e => setDays(e.target.value)} aria-label="Days of history to request from Plaid" /> days</label>
        {days.trim() !== (daysSaved ?? '365') && <button type="button" className="btn small" onClick={() => void saveDays()}>Save</button>}
        <span className="muted small">30 to 730; used when a bank is connected.{daysSaved ? '' : ' Default 365.'}</span>
      </div>
      <div className="form-actions">
        {!s && <button type="button" className="btn primary" disabled={!!busy} onClick={connect}><Link2 size={15} /> {busy === 'connect' ? 'Opening Plaid…' : live ? 'Connect the bank with Plaid' : 'Connect with Plaid (sandbox)'}</button>}
        {s && !otherEnv && <button type="button" className="btn primary" disabled={!!busy} onClick={sync}><RefreshCw size={15} /> {busy === 'sync' ? 'Syncing…' : 'Sync now'}</button>}
        {s && <button type="button" className="btn" disabled={!!busy} onClick={unlink}><Unlink size={15} /> Disconnect</button>}
      </div>
    </div>
  );
}
