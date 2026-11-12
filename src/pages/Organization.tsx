import RecordForm, { type Field } from '../components/RecordForm';
import { supabase, type Row } from '../lib/supabase';
import { OrgLogo } from '../components/Layout';
import type { Org } from '../lib/org';
import { useAuth } from '../lib/auth';
import { useState } from 'react';
import { FooterSettings } from '../components/PoweredBy';

const TIMEZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Toronto', 'Asia/Jerusalem', 'Europe/London']
  .map(v => ({ value: v, label: v }));

const SECTIONS: { title: string; description: string; save: string; fields: Field[] }[] = [
  {
    title: 'Identity', description: 'Who the organization is, as shown across the portal and on letters.', save: 'Save identity',
    fields: [
      { name: 'name', label: 'Organization name', required: true, help: 'Shown across the portal' },
      { name: 'legal_name', label: 'Legal name', help: 'As it appears on receipts' },
      { name: 'ein', label: 'EIN' },
      { name: 'address', label: 'Address' },
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
