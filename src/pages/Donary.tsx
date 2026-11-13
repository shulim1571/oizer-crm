import { useEffect, useState } from 'react';
import { Link2 } from 'lucide-react';
import { Pill } from '../components/Pill';
import { useAuth } from '../lib/auth';
import { dateTime } from '../lib/format';
import { supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';

// The Donary Enterprise connection: lists out to Donary's devices, payments, pledges and schedules back in.

const EVENT_NAME: Record<string, string> = { charge: 'Payment', void: 'Void', pledge: 'Pledge', schedule: 'Schedule' };
const KIND_NAME: Record<string, string> = { donor: 'Donor', campaign: 'Campaign', reason: 'Sub-campaign' };
const WEBHOOKS = [
  { setting: 'PaymentWebhookEndpoint', event: 'charge' },
  { setting: 'PaymentStatusUpdateWebhookEndpoint', event: 'void' },
  { setting: 'PledgeWebhookEndpoint', event: 'pledge' },
  { setting: 'ScheduleWebhookEndpoint', event: 'schedule' },
];

export default function DonaryPage() {
  const { isSuperAdmin } = useAuth();
  const q = useQuery(async () => {
    const { data, error } = await supabase.rpc('donary_status');
    if (error) throw new Error(error.message);
    return data as Row | null;
  });
  const s = (q.data as Row | null | undefined) ?? null;
  const [form, setForm] = useState({ enabled: false, guid: '', key: '' });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { if (s) setForm(f => ({ ...f, enabled: !!s.enabled, guid: s.org_guid ?? '' })); }, [s]);
  const hook = (event: string) => `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/donary-webhook?event=${event}&token=${s?.webhook_token ?? '…'}`;

  async function run(fn: () => PromiseLike<{ error: { message: string } | null; data?: unknown }>, ok: (d: unknown) => string) {
    setMsg(null);
    const { error, data } = await fn();
    setMsg(error ? { ok: false, text: error.message } : { ok: true, text: ok(data) });
    q.reload();
  }

  return (
    <section className="view">
      <div className="view-head">
        <div className="view-title"><h1>Donary</h1><span className="count">Lists to Donary devices; payments, pledges and schedules back</span></div>
      </div>
      {msg && <div className={msg.ok ? 'notice' : 'error'}>{msg.text}</div>}
      {q.error && <div className="error">{q.error}</div>}

      <div className="panel-box">
        <h2><Link2 size={16} /> Connection {s?.enabled ? <Pill tone="green">On</Pill> : <Pill>Off</Pill>}</h2>
        <p className="muted small">Donors and campaigns are sent to Donary when they’re added or changed (sub-campaigns go as Donary “reasons”).
          Donary has no way to delete, so deleted records simply stop being sent.</p>
        {isSuperAdmin ? (
          <>
            <div className="fields">
              <label className="field"><span>orgGuid</span>
                <input value={form.guid} spellCheck={false} placeholder="115e9d3d-baf2-4089-b896-9b2621ffcf1b" onChange={e => setForm({ ...form, guid: e.target.value })} /></label>
              <label className="field"><span>API key</span>
                <input type="password" autoComplete="new-password" value={form.key} placeholder={s?.api_key_set ? 'On file. Type a new one to replace it' : 'From Donary’s integrations team'}
                  onChange={e => setForm({ ...form, key: e.target.value })} /></label>
            </div>
            <label className="check"><input type="checkbox" checked={form.enabled} onChange={e => setForm({ ...form, enabled: e.target.checked })} /> Connected</label>
            <div className="form-actions">
              {s?.enabled && <button className="btn" onClick={() => confirm('Send every campaign and donor to Donary now?') &&
                run(() => supabase.rpc('donary_queue_all'), n => `${n} records are waiting to go to Donary.`)}>Send everything</button>}
              <div className="spacer" />
              <button className="btn primary" onClick={() => run(() => supabase.rpc('save_donary_settings', { p_enabled: form.enabled, p_org_guid: form.guid || null, p_api_key: form.key || null }),
                () => { setForm(f => ({ ...f, key: '' })); return 'Saved.'; })}>Save</button>
            </div>
          </>
        ) : <p className="muted small">Only the Super Admin can change the connection.</p>}
        {s && <p className="muted small">{s.waiting} waiting to send · {s.stuck} couldn’t be sent{s.last_sent ? ` · last sent ${dateTime(s.last_sent)}` : ''}</p>}
        {(s?.problems ?? []).length > 0 && (
          <div className="table-wrap"><table className="grid">
            <thead><tr><th>Record</th><th>Problem</th><th>Tries</th></tr></thead>
            <tbody>{(s!.problems as Row[]).map((p, i) => (
              <tr key={i}><td>{KIND_NAME[p.kind]} {p.ref_id}</td><td>{p.error}</td><td>{p.attempts}{p.given_up ? ' (stopped)' : ''}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </div>

      {isSuperAdmin && s && (
        <div className="panel-box">
          <h2>Webhook addresses for Donary</h2>
          <p className="muted small">Donary sets these on their side. Send them to Donary’s integrations team, and ask for ScheduleHandlingMode “Donary”
            so Donary runs recurring schedules and sends each payment here. Treat them like passwords: anyone with one can post to it.</p>
          <div className="table-wrap"><table className="grid dns">
            <tbody>{WEBHOOKS.map(w => <tr key={w.event}><td>{w.setting}</td><td><code>{hook(w.event)}</code></td></tr>)}</tbody>
          </table></div>
          <div className="form-actions"><div className="spacer" />
            <button className="btn" onClick={() => confirm('Make new addresses? The old ones stop working at once, and Donary has to be given the new ones.') &&
              run(() => supabase.rpc('rotate_donary_webhook_token'), () => 'New addresses made. Send them to Donary.')}>Make new addresses</button>
          </div>
        </div>
      )}

      <h2>From Donary</h2>
      <div className="table-card"><div className="table-wrap">
        <table className="grid">
          <thead><tr><th>Received</th><th>What</th><th>Donary #</th><th>Result</th><th>Record</th><th /></tr></thead>
          <tbody>
            {(s?.events ?? []).length === 0 && <tr><td colSpan={6} className="muted">Nothing yet.</td></tr>}
            {((s?.events ?? []) as Row[]).map(e => (
              <tr key={e.id}>
                <td>{dateTime(e.received_at)}</td><td>{EVENT_NAME[e.event]}</td><td><code>{e.event_key}</code></td>
                <td>{e.status === 'recorded' ? <Pill tone="green">Recorded</Pill> : e.status === 'unmatched' ? <Pill tone="amber">Needs attention</Pill> : <Pill>Ignored</Pill>}
                  {e.detail && <div className="muted small">{e.detail}</div>}</td>
                <td>{e.donation_id ? `Donation ${e.donation_id}` : e.pledge_id ? `Pledge ${e.pledge_id}` : ''}</td>
                <td>{e.status === 'unmatched' && <button className="btn" onClick={() => run(() => supabase.rpc('donary_retry_event', { p_id: e.id }),
                  d => ((d as Row)?.status === 'recorded' ? 'Recorded.' : `Still needs attention: ${(d as Row)?.detail}`))}>Try again</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div></div>
    </section>
  );
}
