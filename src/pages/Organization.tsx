import RecordForm, { type Field } from '../components/RecordForm';
import { supabase, type Row } from '../lib/supabase';
import { OrgLogo } from '../components/Layout';
import type { Org } from '../lib/org';
import { useAuth } from '../lib/auth';
import { useEffect, useState } from 'react';
import { FooterSettings } from '../components/PoweredBy';
import { parseStaleDays, STALE_CHECK_DEFAULT } from '../lib/staleCheck';
import { IDLE_MINUTES_DEFAULT, parseIdleMinutes } from '../lib/idle';

const TIMEZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Toronto', 'Asia/Jerusalem', 'Europe/London']
  .map(v => ({ value: v, label: v }));

const SECTIONS: { title: string; description: string; save: string; fields: Field[] }[] = [
  {
    title: 'Identity', description: 'Who the organization is, as shown across the portal and on letters.', save: 'Save identity',
    fields: [
      { name: 'name', label: 'Organization name', required: true, help: 'Shown across the portal' },
      { name: 'legal_name', label: 'Legal name', help: 'As it appears on receipts' },
      { name: 'ein', label: 'EIN' },
      { name: 'address', label: 'Address', uspsCheck: true },
      { name: 'phone', label: 'Phone' },
      { name: 'email', label: 'Email', type: 'email' },
    ],
  },
  {
    title: 'Receipts and payments', description: 'What receipts, payment pages and printed checks show.', save: 'Save receipt details',
    fields: [
      { name: 'zelle', label: 'Zelle' },
      { name: 'check_payee', label: 'Checks payable to' },
      { name: 'director_name', label: 'Director name' },
    ],
  },
  {
    title: 'Branding and time zone', description: 'How the portal looks, and the time zone for dates, reports and digests.', save: 'Save branding',
    fields: [
      { name: 'timezone', label: 'Time zone', type: 'select', options: TIMEZONES, required: true },
      { name: 'logo_url', label: 'Logo URL' },
      { name: 'primary_color', label: 'Primary color', help: 'A hex color such as #4f46e5. Leave empty for the default.' },
    ],
  },
];

export default function OrganizationPage() {
  const { org, refresh } = useAuth();
  const [saved, setSaved] = useState<string | null>(null);
  if (!org) return null;
  return (
    <section className="view">
      <div className="view-head">
        <div className="view-title"><h1>Organization</h1><span className="count">Your details and branding</span></div>
      </div>
      {saved && <div className="notice">{saved} saved.</div>}
      <LogoUpload org={org} onSaved={() => { setSaved('Logo'); refresh(); }} />
      {SECTIONS.map(sec => (
        <div key={sec.title} className="settings-section">
          <RecordForm
            inline
            table="organizations"
            title={sec.title}
            description={sec.description}
            saveLabel={sec.save}
            // An uploaded logo is managed by the Logo box above; the address field is for a linked logo only.
            fields={String(org.logo_url ?? "").startsWith("data:") ? sec.fields.filter(f => f.name !== "logo_url") : sec.fields}
            record={org}
            onClose={() => setSaved(null)}
            onSaved={() => { setSaved(sec.title); refresh(); }}
          />
        </div>
      ))}
      {/* The stale-check threshold (Moshe Henig, 2026-11-12): already a setting the Task Sheet reads. */}
      <NumberSetting orgId={String(org.id)} settingKey="stale_check_days" title="Task Sheet" intro="When the Task Sheet flags things that need a look."
        label="Stale check after (days)" unit="days" defaultValue={STALE_CHECK_DEFAULT} parse={parseStaleDays} saveLabel="Save Task Sheet settings"
        help="A check payout that hasn't cleared shows on the Task Sheet as a Stale Check this many days after it was entered. Voided and lost checks are skipped."
        onSaved={() => { window.dispatchEvent(new Event('task-sheet-changed')); setSaved('Task Sheet'); }} />
      {/* Idle sign-out (Moshe Henig, 2026-11-12): signed out only after this long with no activity. */}
      <NumberSetting orgId={String(org.id)} settingKey="idle_timeout_minutes" title="Security" intro="How long someone can leave Donor Base untouched before being signed out."
        label="Sign out after (minutes idle)" unit="minutes" defaultValue={IDLE_MINUTES_DEFAULT} parse={parseIdleMinutes} saveLabel="Save security settings"
        help="Anyone who leaves the app with no activity (clicks, typing, scrolling, moving between pages, saving) for this long is signed out. From 5 to 720 minutes; it applies from each person's next sign-in or page load."
        onSaved={() => { setSaved('Security'); void refresh(); }} />
      <UspsKeys />
      <FooterSettings />
    </section>
  );
}

/**
 * Upload the organization's logo (Shulim, 2026-11-12): shown to its staff in the sidebar and at sign-in, and on its
 * payment pages; without one, the Donor Base logo shows. The image is shrunk to at most 256 pixels here and stored
 * with the organization, so no separate file storage is needed. The Logo URL field below still works too.
 */
function LogoUpload({ org, onSaved }: { org: Row; onSaved: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function upload(file: File) {
    setError(null);
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return setError('Choose a PNG, JPG or WebP image.');
    if (file.size > 8_000_000) return setError('That image is too large (over 8 MB).');
    setBusy(true);
    try {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, 256 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      const ctx = canvas.getContext('2d')!;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/png');
      if (dataUrl.length > 600_000) throw new Error('That image is too detailed to store; try a simpler or smaller logo.');
      const { error: e } = await supabase.from('organizations').update({ logo_url: dataUrl }).eq('id', org.id);
      if (e) throw new Error(e.message);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }
  async function remove() {
    if (!confirm('Remove the logo? The Donor Base logo shows instead.')) return;
    const { error: e } = await supabase.from('organizations').update({ logo_url: null }).eq('id', org.id);
    if (e) return setError(e.message);
    onSaved();
  }
  return (
    <div className="settings-section card logo-upload">
      <h3>Logo</h3>
      <div className="logo-upload-row">
        <OrgLogo org={org as Org} />
        <div>
          <p className="muted small">Shown to your staff in the menu and at sign-in, and on your payment pages. Without one, the Donor Base logo shows.</p>
          <label className="btn">{busy ? 'Uploading…' : 'Upload logo'}
            <input type="file" accept="image/png,image/jpeg,image/webp" hidden disabled={busy} onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void upload(f); }} />
          </label>
          {org.logo_url && <button type="button" className="btn" onClick={() => void remove()}>Remove logo</button>}
        </div>
      </div>
      {error && <div className="error">{error}</div>}
    </div>
  );
}

/**
 * One number kept as an organization setting (settings table, one row per organization and key), shown and changed
 * here by the organization's admins. The database keeps each admin to their own organization's rows.
 */
function NumberSetting({ orgId, settingKey, title, intro, label, unit, help, defaultValue, parse, saveLabel, onSaved }: {
  orgId: string; settingKey: string; title: string; intro: string; label: string; unit: string; help: string;
  defaultValue: number; parse: (text: string) => number | string; saveLabel: string; onSaved: () => void;
}) {
  const [text, setText] = useState('');
  const [stored, setStored] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    supabase.from('settings').select('value').eq('key', settingKey).maybeSingle().then(({ data, error: e }) => {
      if (e) return setError(e.message);
      const n = data?.value == null ? null : Number(data.value);
      setStored(n);
      setText(String(n ?? defaultValue));
    });
  }, [orgId, settingKey, defaultValue]);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const n = parse(text);
    if (typeof n === 'string') return setError(n);
    setSaving(true);
    const { error: err } = await supabase.from('settings').upsert({ org_id: orgId, key: settingKey, value: n }, { onConflict: 'org_id,key' });
    setSaving(false);
    if (err) return setError(err.message);
    setStored(n);
    onSaved();
  }
  return (
    <div className="settings-section">
      <form className="record-form" onSubmit={save}>
        <div className="form-head"><h2>{title}</h2></div>
        <p className="muted small form-desc">{intro}</p>
        <div className="fields">
          <label className="field"><span>{label}</span>
            <input type="number" step={1} value={text} onChange={e => setText(e.target.value)} />
            <small className="muted">{help} {stored == null ? `Not set yet, so the default of ${defaultValue} ${unit} applies.` : `Default ${defaultValue} ${unit}.`}</small>
          </label>
        </div>
        {error && <div className="error">{error}</div>}
        <div className="form-actions"><div className="spacer" /><button className="btn primary" disabled={saving}>{saving ? 'Saving…' : saveLabel}</button></div>
      </form>
    </div>
  );
}

/**
 * The organization's own USPS credentials for address checks (Shulim, 2026-11-12): a consumer key and secret from a
 * USPS developer account (developers.usps.com). Stored encrypted; the secret never comes back to the browser. Only the
 * Super Admin sets them; admins see whether they're set.
 */
function UspsKeys() {
  const { isSuperAdmin } = useAuth();
  const [version, setVersion] = useState(0);
  const [status, setStatus] = useState<Row | null | undefined>(undefined);
  const [key, setKey] = useState('');
  const [secret, setSecret] = useState('');
  const [env, setEnv] = useState('production');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    supabase.rpc('usps_keys_status').then(({ data }) => {
      const row = ((data ?? []) as Row[])[0] ?? null;
      setStatus(row);
      if (row?.environment) setEnv(row.environment);
    });
  }, [version]);
  const set = !!status?.key_hint && !!status?.secret_set;
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null); setNote(null);
    const { error: err } = await supabase.rpc('save_usps_keys', { p_consumer_key: key || null, p_consumer_secret: secret || null, p_environment: env });
    if (err) return setError(err.message);
    setKey(''); setSecret(''); setNote('USPS keys saved. Reload the page to see "Check with USPS" under address fields.');
    setVersion(v => v + 1);
  }
  async function clear() {
    if (!confirm('Remove this organization\'s USPS keys? Address checks stop being offered.')) return;
    const { error: err } = await supabase.rpc('clear_usps_keys');
    if (err) return setError(err.message);
    setVersion(v => v + 1);
  }
  if (status === undefined) return null;
  return (
    <div className="settings-section">
      <form className="record-form" onSubmit={save}>
        <div className="form-head"><h2>USPS address check</h2></div>
        <p className="muted small form-desc">
          With your own USPS developer keys, address fields (donors, payees, this page) get a "Check with USPS" button that standardizes the address.
          {set ? ` Set up: key ${status?.key_hint}, ${status?.environment === 'test' ? 'USPS test environment' : 'production'}${status?.updated_by ? `, by ${status.updated_by}` : ''}.` : ' Not set up yet.'}
        </p>
        {isSuperAdmin ? (
          <>
            <div className="fields">
              <label className="field"><span>Consumer key</span><input value={key} onChange={e => setKey(e.target.value)} placeholder={set ? 'Leave empty to keep the one on file' : 'From developers.usps.com → Apps'} autoComplete="off" /></label>
              <label className="field"><span>Consumer secret</span><input type="password" value={secret} onChange={e => setSecret(e.target.value)} placeholder={set ? 'Leave empty to keep the one on file' : ''} autoComplete="new-password" /></label>
              <label className="field"><span>USPS environment</span>
                <select value={env} onChange={e => setEnv(e.target.value)}><option value="production">Production (apis.usps.com)</option><option value="test">Test (apis-tem.usps.com)</option></select></label>
            </div>
            {error && <div className="error">{error}</div>}
            {note && <div className="notice">{note}</div>}
            <div className="form-actions">
              {set && <button type="button" className="btn danger" onClick={() => void clear()}>Remove keys</button>}
              <div className="spacer" /><button className="btn primary">Save USPS keys</button>
            </div>
          </>
        ) : <p className="muted small">The Super Admin enters these.</p>}
      </form>
    </div>
  );
}
