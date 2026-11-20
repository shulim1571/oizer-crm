import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { Pill } from '../components/Pill';
import { useAuth } from '../lib/auth';
import { dateTime } from '../lib/format';
import { requestOrgId, supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';

// Make ingest (Shulim, 2026-11-12): addresses Make posts transactions to, one per source. Each organization has its
// own secret (shown once; only a fingerprint is kept) and on/off switch. Everything recorded is test data, tagged
// with the batch so it can be removed in one step.

export const MAKE_SOURCES: { value: string; label: string }[] = [
  { value: 'donary-payment', label: 'Donary payment' },
  { value: 'donary-pledge', label: 'Donary pledge' },
  { value: 'donary-void', label: 'Donary void' },
  { value: 'donary-schedule', label: 'Donary schedule' },
  { value: 'sola', label: 'Sola transaction' },
  { value: 'elevon', label: 'Elevon transaction' },
];
export const MAKE_HEADER = 'x-donorbase-key';
export const makeUrl = (org: string, source: string) =>
  `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/make-ingest?org=${org}&source=${source}`;

export function MakeIngestSettings() {
  const { isSuperAdmin, org } = useAuth();
  const orgId = requestOrgId() ?? org?.id ?? '';
  const status = useQuery(async () => {
    const { data, error } = await supabase.rpc('make_ingest_status');
    if (error) throw new Error(error.message);
    return ((data as Row[]) ?? [])[0] ?? null;
  });
  const recent = useQuery(async () => {
    const { data, error } = await supabase.rpc('make_ingest_recent');
    if (error) throw new Error(error.message);
    return (data as Row[]) ?? [];
  });
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const s = status.data;

  async function newSecret() {
    if (s?.secret_set && !confirm('Make a new secret? Make stops getting through until each scenario has the new one.')) return;
    setError(null);
    const { data, error: e } = await supabase.rpc('make_ingest_new_secret');
    if (e) return setError(e.message);
    setSecret(data as string);
    status.reload();
  }
  async function setEnabled(on: boolean) {
    setError(null);
    const { error: e } = await supabase.rpc('make_ingest_set_enabled', { p_enabled: on });
    if (e) return setError(e.message);
    status.reload();
  }

  return (
    <div className="panel-box make-ingest">
      <h2>Make <span className="muted small">receiving addresses for test transactions</span></h2>
      {(status.error || recent.error) && <div className="error">{status.error ?? recent.error}</div>}
      <p className="muted small">
        Make sends each transaction with <b>POST</b> and the secret in the <code>{MAKE_HEADER}</code> header. Everything recorded here is
        test data in batch <code>{s?.batch_id ?? '…'}</code>, which can be removed in one step.
      </p>
      <div className="multi">
        {s?.enabled ? <Pill tone="green">On</Pill> : <Pill tone="">Off</Pill>}
        {s?.secret_set ? <span className="muted small">Secret ends in …{s.secret_hint}</span> : <span className="muted small">No secret yet</span>}
        {s?.last_event_at && <span className="muted small">Last received {dateTime(s.last_event_at)} · {s.events_24h} in 24 hours</span>}
        {isSuperAdmin && <>
          <div className="spacer" />
          <button className="btn" onClick={newSecret}>{s?.secret_set ? 'New secret' : 'Create secret'}</button>
          <button className="btn" disabled={!s?.secret_set} onClick={() => setEnabled(!s?.enabled)}>{s?.enabled ? 'Switch off' : 'Switch on'}</button>
        </>}
      </div>
      {error && <div className="error">{error}</div>}
      {secret && (
        <div className="notice">
          <b><KeyRound size={14} /> Copy the secret now; it is shown only this once.</b>
          <div className="multi">
            <code className="api-key">{secret}</code>
            <button className="btn" onClick={() => navigator.clipboard.writeText(secret)}>Copy</button>
            <button className="btn" onClick={() => setSecret(null)}>Done</button>
          </div>
        </div>
      )}
      <div className="table-wrap">
        <table className="grid">
          <thead><tr><th>Source</th><th>Address</th></tr></thead>
          <tbody>
            {MAKE_SOURCES.map(m => (
              <tr key={m.value}><td>{m.label}</td><td><code className="break">{makeUrl(orgId, m.value)}</code></td></tr>
            ))}
          </tbody>
        </table>
      </div>
      {(recent.data ?? []).length > 0 && (
        <details className="help">
          <summary>Recently received</summary>
          <table className="grid">
            <thead><tr><th>When</th><th>Source</th><th>Result</th><th>Record</th><th /></tr></thead>
            <tbody>
              {(recent.data ?? []).map((r, i) => (
                <tr key={i}><td>{dateTime(r.created_at)}</td><td>{r.source}</td>
                  <td><Pill tone={r.outcome === 'error' ? 'red' : r.outcome === 'created' ? 'green' : ''}>{r.outcome}</Pill></td>
                  <td>{r.record_id ?? ''}</td><td className="muted small">{r.message ?? ''}</td></tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}
