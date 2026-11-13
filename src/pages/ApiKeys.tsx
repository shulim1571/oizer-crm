import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { Pill } from '../components/Pill';
import { useAuth } from '../lib/auth';
import { dateTime } from '../lib/format';
import { supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';
import { AssistantSettings } from './Assistant';
import { MakeIngestSettings } from './MakeIngest';

// Read-only API keys for the organization's own systems. The Super Admin creates and revokes them; the key is
// shown once and only its hash is kept.

const SCOPES: { value: string; label: string; needs?: string }[] = [
  { value: 'campaigns', label: 'Campaigns' },
  { value: 'donors', label: 'Donors (names)' },
  { value: 'donor_contact', label: 'Donors’ email, phone and address', needs: 'donors' },
  { value: 'donations', label: 'Donations' },
];
export const API_BASE = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/api/v1`;

export default function ApiKeysPage() {
  const { isSuperAdmin } = useAuth();
  const keys = useQuery(async () => {
    const { data, error } = await supabase.rpc('list_api_keys');
    if (error) throw new Error(error.message);
    return data as Row[];
  });
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['campaigns', 'donations']);
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function create() {
    setError(null);
    const { data, error: e } = await supabase.rpc('create_api_key', { p_name: name, p_scopes: scopes });
    if (e) return setError(e.message);
    setCreated(data as string);
    setCopied(false);
    setName('');
    keys.reload();
  }
  async function revoke(k: Row) {
    if (!confirm(`Revoke “${k.name}”? Anything using it stops working immediately.`)) return;
    const { error: e } = await supabase.rpc('revoke_api_key', { p_id: k.id });
    if (e) return setError(e.message);
    keys.reload();
  }

  return (
    <section className="view">
      <div className="view-head">
        <div className="view-title"><h1>API Keys</h1><span className="count">Read-only access for your own systems</span></div>
      </div>
      {keys.error && <div className="error">{keys.error}</div>}

      {created && (
        <div className="panel-box">
          <h2><KeyRound size={16} /> Copy the new key now</h2>
          <p className="muted small">This is the only time it is shown. Keep it on a server; never put it in a web page.</p>
          <div className="multi">
            <code className="api-key">{created}</code>
            <button className="btn" onClick={async () => { await navigator.clipboard.writeText(created); setCopied(true); }}>{copied ? 'Copied' : 'Copy'}</button>
            <button className="btn" onClick={() => setCreated(null)}>Done</button>
          </div>
        </div>
      )}

      <div className="table-card"><div className="table-wrap">
        <table className="grid">
          <thead><tr><th>Name</th><th>Key</th><th>Can read</th><th>Created</th><th>Last used</th><th>Status</th><th /></tr></thead>
          <tbody>
            {(keys.data ?? []).length === 0 && <tr><td colSpan={7} className="muted">No keys yet.</td></tr>}
            {(keys.data ?? []).map(k => (
              <tr key={k.id}>
                <td><b>{k.name}</b></td>
                <td><code>oz_live_{k.prefix}_…</code></td>
                <td>{(k.scopes as string[]).map(v => (v === 'donor_contact' ? 'donor contact details' : v)).join(', ')}</td>
                <td>{dateTime(k.created_at)}<div className="muted small">{k.created_by}</div></td>
                <td>{k.last_used_at ? dateTime(k.last_used_at) : <span className="muted">Never</span>}</td>
                <td>{k.revoked_at ? <Pill tone="red">Revoked</Pill> : <Pill tone="green">Active</Pill>}</td>
                <td>{isSuperAdmin && !k.revoked_at && <button className="btn danger" onClick={() => revoke(k)}>Revoke</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div></div>

      {isSuperAdmin ? (
        <div className="panel-box">
          <h2>New key</h2>
          <div className="fields">
            <label className="field"><span>Name</span>
              <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Accounting export" maxLength={80} />
            </label>
            <fieldset className="field"><span>Can read</span>
              {SCOPES.map(s => (
                <label key={s.value} className="check">
                  <input type="checkbox" checked={scopes.includes(s.value)} disabled={!!s.needs && !scopes.includes(s.needs)}
                    onChange={e => setScopes(x => (e.target.checked ? [...x, s.value]
                      // Contact details go with reading donors.
                      : x.filter(v => v !== s.value && !(s.value === 'donors' && v === 'donor_contact'))))} /> {s.label}
                </label>
              ))}
            </fieldset>
          </div>
          {error && <div className="error">{error}</div>}
          <div className="form-actions"><div className="spacer" />
            <button className="btn primary" disabled={!name.trim() || !scopes.length} onClick={create}>Create key</button>
          </div>
        </div>
      ) : <p className="muted small">Only the Super Admin can create or revoke keys.</p>}

      <details className="help">
        <summary>Using the API (reference)</summary>
        <p className="muted small">Every request sends the key. Each key may make 60 requests a minute; lists come 50 at a time (up to 100 with <code>limit</code>), and <code>next</code> is the <code>after</code> for the following page.</p>
        <pre className="api-example">{`curl -H "Authorization: Bearer oz_live_…" \\
  "${API_BASE}/donations?limit=100&updated_since=2026-11-01T00:00:00Z"`}</pre>
        <ul className="muted small">
          <li><code>GET /campaigns</code>, <code>/campaigns/&lt;id&gt;</code></li>
          <li><code>GET /donors</code>, <code>/donors/&lt;id&gt;</code>: names; email, phone and address only for a key allowed them</li>
          <li><code>GET /donations</code>, <code>/donations/&lt;id&gt;</code>, also <code>?campaign_id=</code> and <code>?donor_id=</code></li>
        </ul>
      </details>
      <MakeIngestSettings />
      <AssistantSettings />
    </section>
  );
}
