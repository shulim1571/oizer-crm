import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { Pill } from '../components/Pill';
import { useAuth } from '../lib/auth';
import { dateTime } from '../lib/format';
import { requestOrgId, supabase } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';

// Each organization's own SendGrid, Twilio and Turnstile keys. Until it sets them, the platform's are used.
// The secret parts are stored encrypted and never come back to the browser; the screen only learns whether they're set.

export interface KeyStatus {
  sendgrid_key_set: boolean; sendgrid_webhook_key_set: boolean; twilio_sid: string | null; twilio_token_set: boolean;
  turnstile_site_key: string | null; turnstile_secret_set: boolean; updated_at: string | null; updated_by: string | null;
}
export const NO_KEYS: KeyStatus = {
  sendgrid_key_set: false, sendgrid_webhook_key_set: false, twilio_sid: null, twilio_token_set: false,
  turnstile_site_key: null, turnstile_secret_set: false, updated_at: null, updated_by: null,
};

export const useKeyStatus = () => useQuery(async () => (((await supabase.rpc('integration_keys_status')).data ?? []) as KeyStatus[])[0] ?? NO_KEYS, []);

export type Service = 'sendgrid' | 'twilio' | 'turnstile';
export const ownKeys = (k: KeyStatus, s: Service) =>
  s === 'sendgrid' ? k.sendgrid_key_set : s === 'twilio' ? !!k.twilio_sid && k.twilio_token_set : !!k.turnstile_site_key && k.turnstile_secret_set;

interface Field { name: string; label: string; secret: boolean; set: boolean; shown?: string | null; placeholder: string; help?: string }
const SAVE: Record<Service, { rpc: string; args: (v: Record<string, string>) => Record<string, string | null> }> = {
  sendgrid: { rpc: 'save_email_keys', args: v => ({ p_api_key: v.api || null, p_webhook_key: v.hook || null }) },
  twilio: { rpc: 'save_sms_keys', args: v => ({ p_sid: v.sid || null, p_token: v.token || null }) },
  turnstile: { rpc: 'save_turnstile_keys', args: v => ({ p_site_key: v.site || null, p_secret: v.secret || null }) },
};
const NAME: Record<Service, string> = { sendgrid: 'SendGrid', twilio: 'Twilio', turnstile: 'Turnstile' };

/** One service's keys: whose are in use, and (for the Super Admin) the fields to set or remove the organization's own. */
export function KeysPanel({ service, status, onSaved, intro, fields, platformNote, children }: {
  service: Service; status: KeyStatus; onSaved: () => void; intro: React.ReactNode; fields: Field[]; platformNote: string; children?: React.ReactNode;
}) {
  const { isSuperAdmin } = useAuth();
  const [v, setV] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const own = ownKeys(status, service);

  async function save() {
    setError(null);
    setSaved(false);
    const { error: e } = await supabase.rpc(SAVE[service].rpc, SAVE[service].args(v));
    if (e) return setError(e.message);
    setV({});
    setSaved(true);
    onSaved();
  }
  async function clear() {
    if (!confirm(`Remove this organization's own ${NAME[service]} keys and go back to the platform's?`)) return;
    setError(null);
    const { error: e } = await supabase.rpc('clear_integration_keys', { p_service: service });
    if (e) return setError(e.message);
    setSaved(false);
    onSaved();
  }

  return (
    <div className="panel-box">
      <h2><KeyRound size={16} /> {NAME[service]} keys {own ? <Pill tone="green">Your own</Pill> : <Pill>Platform's</Pill>}</h2>
      <p className="muted small">{own ? 'This organization uses its own account.' : platformNote}</p>
      {children}
      {isSuperAdmin ? (
        <>
          <p className="muted small">{intro}</p>
          <div className="fields">
            {fields.map(f => (
              <label key={f.name} className="field wide"><span>{f.label}</span>
                <input type={f.secret ? 'password' : 'text'} autoComplete={f.secret ? 'new-password' : 'off'} spellCheck={false} value={v[f.name] ?? ''}
                  onChange={e => setV(x => ({ ...x, [f.name]: e.target.value }))}
                  placeholder={f.set ? `On file${f.shown ? ` (${f.shown})` : ''}. Type a new one to replace it` : f.placeholder} />
                {f.help && <small className="muted">{f.help}</small>}
              </label>
            ))}
          </div>
          {saved && <div className="notice">Saved.</div>}
          {error && <div className="error">{error}</div>}
          <div className="form-actions">
            {own && <button type="button" className="btn" onClick={clear}>Use the platform's keys</button>}
            <div className="spacer" />
            <button type="button" className="btn primary" disabled={!Object.values(v).some(x => x.trim())} onClick={save}>Save</button>
          </div>
        </>
      ) : <p className="muted small">Only the Super Admin can change these keys.</p>}
      {own && status.updated_at && <p className="muted small">Keys last changed {dateTime(status.updated_at)} by {status.updated_by}.</p>}
    </div>
  );
}

/** Where the providers send delivery reports for this organization's own accounts. */
export const ownWebhook = (provider: 'sendgrid' | 'twilio', orgId: string | undefined) =>
  `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/message-events?provider=${provider}&org=${requestOrgId() ?? orgId ?? ''}`;

/** The payment page's bot check. */
export function TurnstileKeys() {
  const q = useKeyStatus();
  const k = (q.data as KeyStatus | undefined) ?? NO_KEYS;
  return (
    <KeysPanel service="turnstile" status={k} onSaved={() => void q.reload()}
      platformNote="Payment pages use the platform's Cloudflare Turnstile check, which may show the platform's domain to donors."
      intro={<>In Cloudflare: Turnstile → Add widget, with the domains your payment pages use (for example <code>oizer.trubase.org</code>). Paste both keys here.</>}
      fields={[
        { name: 'site', label: 'Site key (public)', secret: false, set: !!k.turnstile_site_key, shown: k.turnstile_site_key, placeholder: '0x4AAA…' },
        { name: 'secret', label: 'Secret key', secret: true, set: k.turnstile_secret_set, placeholder: '0x4AAA…', help: 'Stored encrypted; only the payment service can read it.' },
      ]} />
  );
}
