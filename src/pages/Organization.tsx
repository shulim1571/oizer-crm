import RecordForm, { type Field } from '../components/RecordForm';
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
      {SECTIONS.map(sec => (
        <div key={sec.title} className="settings-section">
          <RecordForm
            inline
            table="organizations"
            title={sec.title}
            description={sec.description}
            saveLabel={sec.save}
            fields={sec.fields}
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
