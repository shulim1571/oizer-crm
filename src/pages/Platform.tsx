import { useState, type FormEvent } from 'react';
import { StatusPill } from '../components/Pill';
import { useAuth } from '../lib/auth';
import { dateTime } from '../lib/format';
import { enterPlatformOrg } from '../lib/org';
import { supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';

const BLANK = { name: '', slug: '', adminEmail: '', hostname: '' };

export default function PlatformPage() {
  const { inPlatformSession } = useAuth();
  const [form, setForm] = useState(BLANK);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const orgs = useQuery(async () => {
    const { data, error } = await supabase.rpc('platform_list_orgs');
    if (error) throw new Error(error.message);
    return data as Row[];
  });

  async function create(e: FormEvent) {
    e.preventDefault();
    const { error } = await supabase.rpc('platform_create_org', {
      p_name: form.name, p_slug: form.slug, p_admin_email: form.adminEmail, p_hostname: form.hostname || null,
    });
    if (error) return setMsg({ ok: false, text: error.message });
    setMsg({ ok: true, text: `${form.name} created. ${form.adminEmail} becomes its admin when they sign in.` });
    setForm(BLANK);
    orgs.reload();
  }

  async function enter(o: Row) {
    const reason = prompt(`Why are you entering ${o.name}? This is written to their activity log.`);
    if (reason === null) return;
    const { error } = await supabase.rpc('platform_enter_org', { p_org: o.id, p_reason: reason || null });
    if (error) return setMsg({ ok: false, text: error.message });
    enterPlatformOrg(o.id);
  }

  async function setStatus(o: Row, status: string) {
    if (status !== 'active' && !confirm(`Set ${o.name} to ${status}? Its people will lose access immediately.`)) return;
    const { error } = await supabase.rpc('platform_set_org_status', { p_org: o.id, p_status: status });
    if (error) return setMsg({ ok: false, text: error.message });
    orgs.reload();
  }

  const field = (k: keyof typeof BLANK, label: string, type = 'text', required = true) => (
    <label className="field"><span>{label}</span>
      <input type={type} required={required} value={form[k]} onChange={e => setForm(f => ({ ...f, [k]: e.target.value }))} />
    </label>
  );

  return (
    <section className="view">
      <div className="view-head">
        <div className="view-title"><h1>Organizations</h1><span className="count">Every organization on the platform</span></div>
      </div>
      {msg && <div className={msg.ok ? 'notice' : 'error'}>{msg.text}</div>}
      {orgs.error && <div className="error">{orgs.error}</div>}

      <div className="table-card"><div className="table-wrap">
        <table className="grid">
          <thead><tr><th>Name</th><th>Web address</th><th>Status</th><th>People</th><th>Campaigns</th><th>Donors</th><th>Donations</th><th>Created</th><th /></tr></thead>
          <tbody>
            {!orgs.loading && (orgs.data ?? []).length === 0 && <tr><td colSpan={9} className="muted">No organizations yet. Add the first one below.</td></tr>}
            {(orgs.data ?? []).map(o => (
              <tr key={o.id}>
                <td><b>{o.name}</b><div className="muted small">{o.slug}</div></td>
                <td>{(o.hostnames as string[]).join(', ')}</td>
                <td><StatusPill value={o.status} /></td>
                <td>{o.member_count}</td>
                <td>{o.campaign_count}</td>
                <td>{o.donor_count}</td>
                <td>{o.donation_count}</td>
                <td>{dateTime(o.created_at)}</td>
                <td>
                  <div className="multi">
                    {!inPlatformSession && <button className="btn" onClick={() => enter(o)}>Enter</button>}
                    {o.status === 'active'
                      ? <button className="btn danger" onClick={() => setStatus(o, 'suspended')}>Suspend</button>
                      : <button className="btn" onClick={() => setStatus(o, 'active')}>Reactivate</button>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div></div>

      <h2>Add an organization</h2>
      <form onSubmit={create} className="platform-form">
        {field('name', 'Name')}
        {field('slug', 'Short name (letters, numbers, dashes)')}
        {field('adminEmail', 'First admin email', 'email')}
        {field('hostname', 'Web address (optional)', 'text', false)}
        <button className="btn primary">Create organization</button>
      </form>
    </section>
  );
}
