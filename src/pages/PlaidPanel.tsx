import { useState } from 'react';
import { Link2, RefreshCw, Unlink } from 'lucide-react';
import { Pill } from '../components/Pill';
import { dateTime } from '../lib/format';
import { requestOrgId, supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';

// Plaid, sandbox only (Shulim, 2026-11-11): link this bank account with a Plaid test institution and pull its
// transactions in as bank lines. The keys live only in the plaid function's secrets.

const LINK_SCRIPT = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';

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
    setMessage('Linked. Use Sync now to bring in its transactions.');
  });

  const sync = () => run('sync', async () => {
    const r = await callPlaid({ action: 'sync', account });
    setMessage(`Synced: ${r.added} new line${r.added === 1 ? '' : 's'}, ${r.updated} updated, ${r.removed} removed.${r.added === 0 && !s?.last_synced_at ? ' A new sandbox link can take a minute before its transactions are ready.' : ''}`);
    status.reload();
    onSynced();
  });

  const unlink = () => {
    if (!confirm('Disconnect this bank account from Plaid? Lines already brought in stay.')) return;
    void run('unlink', async () => { await callPlaid({ action: 'unlink', account }); status.reload(); setMessage('Disconnected.'); });
  };

  return (
    <div className="panel-box plaid-panel">
      <h3><Link2 size={15} /> Plaid <Pill tone="amber">Sandbox</Pill> {s && <Pill tone="green">Linked</Pill>}</h3>
      {s ? (
        <p className="muted small">
          {s.institution_name ?? 'Bank'} · {s.account_name ?? 'Account'}{s.account_mask ? ` ••${s.account_mask}` : ''} · linked {dateTime(s.linked_at)}
          {s.last_synced_at ? <> · last synced {dateTime(s.last_synced_at)}</> : <> · not synced yet</>}
        </p>
      ) : (
        <p className="muted small">Test institutions only: in Plaid Link pick any bank and sign in with <code>user_good</code> / <code>pass_good</code>. No real bank is connected.</p>
      )}
      {s?.last_error && <div className="error">Last sync failed: {s.last_error}</div>}
      {message && <p className="muted">{message}</p>}
      {error && <div className="error">{error}</div>}
      <div className="form-actions">
        {!s && <button type="button" className="btn primary" disabled={!!busy} onClick={connect}><Link2 size={15} /> {busy === 'connect' ? 'Opening Plaid…' : 'Connect with Plaid (sandbox)'}</button>}
        {s && <button type="button" className="btn primary" disabled={!!busy} onClick={sync}><RefreshCw size={15} /> {busy === 'sync' ? 'Syncing…' : 'Sync now'}</button>}
        {s && <button type="button" className="btn" disabled={!!busy} onClick={unlink}><Unlink size={15} /> Disconnect</button>}
      </div>
    </div>
  );
}
