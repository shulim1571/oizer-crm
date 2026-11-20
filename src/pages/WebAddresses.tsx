import { useEffect, useState } from 'react';
import { Globe } from 'lucide-react';
import { Pill } from '../components/Pill';
import { useAuth } from '../lib/auth';
import { dateTime } from '../lib/format';
import { requestOrgId, supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';

// The organization's web addresses: its default <slug>.trubase.org and up to five of its own. Cloudflare verifies
// each domain and issues its certificate once the DNS records shown here are in place.

const PLATFORM_DOMAIN = 'trubase.org';

async function callDomains(body: Row) {
  const { data, error } = await supabase.functions.invoke('domains', { body: { ...body, org: requestOrgId() } });
  if (error) {
    const detail = await (error as { context?: Response }).context?.json?.().catch(() => null);
    throw new Error(detail?.error ?? 'The web address service didn’t answer. Try again shortly.');
  }
  if (data?.error) throw new Error(data.error);
  return data as Row;
}

function state(a: Row): { tone: 'green' | 'amber' | 'red' | 'blue'; text: string } {
  if (a.leads_here) return { tone: 'green', text: 'Live' };
  if (a.status === 'failed') return { tone: 'red', text: 'Needs attention' };
  if (a.status === 'active') return { tone: 'blue', text: 'Certificate on its way' };
  return { tone: 'amber', text: 'Waiting for DNS' };
}

export default function WebAddressesPage() {
  const { isSuperAdmin, org } = useAuth();
  const list = useQuery(async () => {
    const { data, error } = await supabase.rpc('web_addresses');
    if (error) throw new Error(error.message);
    return data as Row[];
  });
  // The status call can't hold the page up: after 8 seconds it counts as not switched on.
  const service = useQuery(async () => Promise.race([
    callDomains({ action: 'status' }).catch(() => ({ ready: false })),
    new Promise<Row>(res => setTimeout(() => res({ ready: false }), 8000)),
  ]), []);
  const [host, setHost] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const rows = list.data ?? [];
  const ready = !!(service.data as Row | undefined)?.ready;
  const subdomain = `${org?.slug ?? ''}.${PLATFORM_DOMAIN}`;
  const hasSubdomain = rows.some(r => r.hostname === subdomain);
  const waiting = rows.filter(r => r.id && !r.leads_here && r.status !== 'failed');

  async function run(key: string, body: Row, done?: string) {
    setBusy(key);
    setMsg(null);
    try {
      await callDomains(body);
      if (done) setMsg({ ok: true, text: done });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
    setBusy(null);
    list.reload();
  }

  // While an address waits on DNS, look again every 30 seconds with the page open.
  useEffect(() => {
    if (!ready || !waiting.length) return;
    const t = setInterval(() => { for (const a of waiting) void callDomains({ action: 'check', id: a.id }).catch(() => null).then(() => list.reload()); }, 30_000);
    return () => clearInterval(t);
  }, [ready, waiting.map(a => a.id).join()]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="view">
      <div className="view-head">
        <div className="view-title"><h1>Web Addresses</h1><span className="count">Where people reach your portal and payment pages</span></div>
      </div>
      {msg && <div className={msg.ok ? 'notice' : 'error'}>{msg.text}</div>}
      {list.error && <div className="error">{list.error}</div>}
      {service.data && !ready && (
        <div className="notice">Setting up new addresses isn’t switched on for the platform yet. Addresses already working keep working.</div>
      )}

      {list.loading && !list.data && <div className="panel-box muted small">Loading addresses…</div>}
      {!list.loading && !list.error && rows.length === 0 && (
        <div className="panel-box">
          <h2><Globe size={16} /> No web addresses yet</h2>
          <p className="muted small">This organization doesn’t have an address of its own yet. {isSuperAdmin ? 'Set one up below once address setup is switched on.' : 'Ask the Super Admin to set one up.'}</p>
        </div>
      )}
      {rows.map(a => {
        const s = state(a);
        return (
          <div key={a.hostname} className="panel-box">
            <h2><Globe size={16} /> {a.hostname} <Pill tone={s.tone}>{s.text}</Pill>
              <span className="muted small">{a.kind === 'subdomain' ? 'Default address' : 'Your own domain'}</span></h2>
            {a.leads_here
              ? <p className="muted small">Working, with its own security certificate. <a href={`https://${a.hostname}`} target="_blank" rel="noreferrer">Open</a></p>
              : (
                <>
                  <p className="muted small">
                    {a.kind === 'subdomain'
                      ? 'The platform adds this record to trubase.org; nothing is needed from you.'
                      : 'Add these records where your domain’s DNS is managed (your registrar or DNS host). Cloudflare checks them automatically; it usually takes a few minutes, sometimes up to a day.'}
                  </p>
                  {(a.dns_records as Row[]).length > 0 && (
                    <div className="table-wrap"><table className="grid dns">
                      <thead><tr><th>Type</th><th>Name</th><th>Value</th><th>Why</th></tr></thead>
                      <tbody>{(a.dns_records as Row[]).map((r, i) => (
                        <tr key={i}><td>{r.type}</td><td><code>{r.name}</code></td><td><code>{r.value}</code></td><td className="muted small">{r.purpose}</td></tr>
                      ))}</tbody>
                    </table></div>
                  )}
                  {a.last_error && <p className="error small">{a.last_error}</p>}
                  {a.checked_at && <p className="muted small">Last checked {dateTime(a.checked_at)}.</p>}
                </>
              )}
            {isSuperAdmin && a.id && (
              <div className="form-actions">
                {!a.leads_here && ready && <button className="btn" disabled={!!busy} onClick={() => run(a.id, { action: 'check', id: a.id })}>{busy === a.id ? 'Checking…' : 'Check now'}</button>}
                <div className="spacer" />
                <button className="btn danger" disabled={!!busy}
                  onClick={() => confirm(`Remove ${a.hostname}? It stops leading to your portal immediately.`) && run(a.id, { action: 'remove', id: a.id }, `${a.hostname} removed.`)}>Remove</button>
              </div>
            )}
          </div>
        );
      })}

      {isSuperAdmin && ready && (
        <>
          {!hasSubdomain && org && (
            <div className="panel-box">
              <h2>Default address</h2>
              <p className="muted small">Every organization can have <b>{subdomain}</b>, ready without any DNS work on your side.</p>
              <div className="form-actions"><div className="spacer" />
                <button className="btn primary" disabled={!!busy} onClick={() => run('sub', { action: 'add', kind: 'subdomain' }, `${subdomain} requested.`)}>Set up {subdomain}</button>
              </div>
            </div>
          )}
          <div className="panel-box">
            <h2>Use your own domain</h2>
            <p className="muted small">A subdomain of a domain you own, such as <code>donate.yourorg.org</code>. You’ll get the DNS records to add; the certificate is issued and renewed automatically.</p>
            <div className="multi">
              <input className="grow" value={host} onChange={e => setHost(e.target.value)} placeholder="donate.yourorg.org" spellCheck={false} />
              <button className="btn primary" disabled={!host.trim() || !!busy}
                onClick={async () => { await run('add', { action: 'add', kind: 'custom', hostname: host }); setHost(''); }}>{busy === 'add' ? 'Adding…' : 'Add'}</button>
            </div>
          </div>
        </>
      )}
      {!isSuperAdmin && <p className="muted small">Only the Super Admin can add or remove addresses.</p>}
    </section>
  );
}
