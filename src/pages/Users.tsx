import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { ROLE_LABEL } from '../components/Layout';
import SearchSelect from '../components/SearchSelect';
import { StatusPill } from '../components/Pill';
import { supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';
import { campaignOptions, managerOptions, type Option } from '../lib/lookups';
import { dateTime } from '../lib/format';
import { useAuth } from '../lib/auth';

const DELEGATABLE: [string, string][] = [
  ['manage_admins', 'Manage admin accounts'],
  ['grant_overrides', 'Grant fundraiser overrides'],
  ['reopen_campaigns', 'Reopen closed campaigns'],
  ['run_imports', 'Run bulk imports'],
  ['reverse_imports', 'Reverse bulk imports'],
  ['configure_fees', 'Configure fees'],
  ['change_default_bank', 'Change default bank account'],
  ['manage_api_keys', 'Manage API keys'],
];

const MEMBER_STATUS: Record<string, string> = { suspended: 'Suspended', deactivated: 'Deactivated' };

export default function UsersPage() {
  const { profile: me, isSuperAdmin, permissions } = useAuth();
  const canManageAdmins = permissions.includes('manage_admins');
  const [managers, setManagers] = useState<Option[]>([]);
  const [campaigns, setCampaigns] = useState<Option[]>([]);
  const [newAdmin, setNewAdmin] = useState('');
  const [guest, setGuest] = useState<{ email: string; campaign: string | null }>({ email: '', campaign: null });
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    managerOptions().then(setManagers);
    campaignOptions().then(setCampaigns);
  }, []);

  const users = useQuery(async () => {
    const [{ data: members, error }, { data: profiles }, { data: links }, { data: locked }, { data: delegations }] = await Promise.all([
      supabase.from('org_members').select('*').order('created_at'),
      supabase.from('profiles').select('*'),
      supabase.from('user_managers').select('*'),
      supabase.rpc('locked_accounts'),
      supabase.from('admin_delegations').select('*'),
    ]);
    if (error) throw new Error(error.message);
    return (members ?? []).map(m => ({
      ...m,
      email: (profiles ?? []).find(p => p.user_id === m.user_id)?.email,
      managers: (links ?? []).filter(l => l.user_id === m.user_id).map(l => l.manager_id),
      lockedUntil: ((locked ?? []) as Row[]).find(l => l.user_id === m.user_id)?.locked_until,
      delegated: (delegations ?? []).filter(d => d.user_id === m.user_id).map(d => d.permission as string),
    }));
  });

  const admins = useQuery(async () => (await supabase.from('admin_emails').select('*').order('email')).data ?? []);
  const guests = useQuery(async () => (await supabase.from('campaign_guests').select('*').order('added_at')).data ?? []);

  async function run(p: PromiseLike<{ error: { message: string } | null }>, ok: string) {
    const { error } = await p;
    setMsg(error ? `Error: ${error.message}` : ok);
    users.reload();
    admins.reload();
    guests.reload();
  }

  const setRole = (u: Row, role: string) =>
    run(supabase.from('org_members').update({ role }).eq('user_id', u.user_id), `${u.email} is now ${ROLE_LABEL[role]}.`);
  const unlock = (u: Row) =>
    run(supabase.rpc('unlock_account', { p_user: u.user_id }), `${u.email} can sign in again.`);
  const link = (u: Row, managerId: string) =>
    run(supabase.from('user_managers').insert({ user_id: u.user_id, manager_id: managerId }), `Linked fundraiser record to ${u.email}.`);
  const unlink = (u: Row, managerId: string) =>
    run(supabase.from('user_managers').delete().eq('user_id', u.user_id).eq('manager_id', managerId), `Unlinked fundraiser record from ${u.email}.`);
  const setStatus = (u: Row, status: string) => {
    const reason = status === 'active' ? '' : prompt(`Suspend ${u.email}? They lose access at once. Reason (optional):`);
    if (reason === null) return;
    run(supabase.rpc('set_member_status', { p_user: u.user_id, p_status: status, p_reason: reason || null }),
      status === 'active' ? `${u.email} is reinstated.` : `${u.email} is suspended.`);
  };
  const transfer = (u: Row) => {
    if (confirm(`Make ${u.email} the Super Admin? You become a regular admin, and only they can change it back.`)) {
      run(supabase.rpc('transfer_super_admin', { p_user: u.user_id }), `${u.email} is now the Super Admin.`);
    }
  };
  const delegate = (u: Row, permission: string, on: boolean) =>
    run(supabase.rpc('set_delegation', { p_user: u.user_id, p_permission: permission, p_on: on }), `Updated ${u.email}'s permissions.`);

  const label = (id: string) => managers.find(m => m.value === id)?.label ?? id;
  const campaignLabel = (id: string) => campaigns.find(c => c.value === id)?.label ?? id;
  const regularAdmins = (users.data ?? []).filter(u => u.role === 'admin');

  return (
    <section className="view">
      <div className="view-head">
        <div className="view-title"><h1>Users &amp; Access</h1><span className="count">Who can sign in and what they can see</span></div>
      </div>
      <div>
        <p className="muted">
          People create their own login on the sign-in page. Emails listed under <b>Admin emails</b> become admins automatically.
          Anyone whose email matches a <b>Fundraiser</b> record sees only campaigns where they are the Primary or a Secondary
          Fundraiser. <b>Community Guests</b> can follow one campaign read-only. Everyone else waits as <b>pending</b> until you assign a role here.
        </p>
        {msg && <div className="notice">{msg}</div>}
        {users.error && <div className="error">{users.error}</div>}

        <h2>Logins</h2>
        <div className="table-card"><div className="table-wrap">
          <table className="grid">
            <thead><tr><th>Email</th><th>Role</th><th>Status</th><th>Linked fundraiser records</th><th>Last sign-in</th></tr></thead>
            <tbody>
              {(users.data ?? []).map(u => {
                const self = u.user_id === me?.user_id;
                const locked = u.role === 'super_admin' || (u.role === 'admin' && !canManageAdmins);
                return (
                  <tr key={u.user_id}>
                    <td>
                      {u.email}
                      {u.lockedUntil && (
                        <div className="muted small">
                          Locked until {dateTime(u.lockedUntil)}{' '}
                          <button className="link" onClick={() => unlock(u)}>Unlock</button>
                        </div>
                      )}
                    </td>
                    <td>
                      {locked || self
                        ? <StatusPill value={ROLE_LABEL[u.role]} />
                        : (
                          <select value={u.role} onChange={e => setRole(u, e.target.value)}>
                            <option value="pending">Pending</option>
                            <option value="manager">Fundraiser</option>
                            <option value="guest">Community Guest</option>
                            {canManageAdmins && <option value="admin">Admin</option>}
                          </select>
                        )}
                      {isSuperAdmin && !self && u.role === 'admin' && (
                        <div><button className="link" onClick={() => transfer(u)}>Make Super Admin</button></div>
                      )}
                    </td>
                    <td>
                      {MEMBER_STATUS[u.status] ? <StatusPill value={MEMBER_STATUS[u.status]} /> : <span className="muted">Active</span>}
                      {!self && !locked && (
                        <div>
                          <button className="link" onClick={() => setStatus(u, u.status === 'active' ? 'suspended' : 'active')}>
                            {u.status === 'active' ? 'Suspend' : 'Reinstate'}
                          </button>
                        </div>
                      )}
                    </td>
                    <td>
                      {u.role === 'manager' && u.managers.length === 0 && (
                        <div className="muted small">Sees nothing until a fundraiser record is linked.</div>
                      )}
                      {u.role === 'guest' && !(guests.data ?? []).some(g => g.email === u.email?.toLowerCase()) && (
                        <div className="muted small">Sees nothing until added to a campaign below.</div>
                      )}
                      <div className="multi">
                        {u.managers.map((m: string) => (
                          <span className="chip" key={m}>{label(m)}<button onClick={() => unlink(u, m)}><Trash2 size={12} /></button></span>
                        ))}
                        {u.role === 'manager' && (
                          <SearchSelect value={null} options={managers.filter(m => !u.managers.includes(m.value))}
                                        onChange={v => v && link(u, v)} placeholder="Link fundraiser…" />
                        )}
                      </div>
                    </td>
                    <td>{dateTime(u.last_login_at) || <span className="muted">Never</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div></div>

        {isSuperAdmin && regularAdmins.length > 0 && (
          <>
            <h2>Delegated permissions</h2>
            <p className="muted">Super Admin powers you've given to individual admins.</p>
            <div className="table-card"><div className="table-wrap">
              <table className="grid">
                <thead><tr><th>Admin</th>{DELEGATABLE.map(([k, l]) => <th key={k}>{l}</th>)}</tr></thead>
                <tbody>
                  {regularAdmins.map(u => (
                    <tr key={u.user_id}>
                      <td>{u.email}</td>
                      {DELEGATABLE.map(([k]) => (
                        <td key={k}><input type="checkbox" checked={u.delegated.includes(k)} onChange={e => delegate(u, k, e.target.checked)} /></td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div></div>
          </>
        )}

        <h2>Community Guests</h2>
        <p className="muted">Guests see donor names, amounts, method and date on one campaign, and can't change anything. Invitation emails aren't sent yet, so tell them to create a login with this email.</p>
        <ul className="plain">
          {(guests.data ?? []).map(g => (
            <li key={`${g.campaign_id}-${g.email}`}>
              {g.email} · {campaignLabel(g.campaign_id)}{' '}
              <button className="icon-btn" title="Remove" onClick={() => run(supabase.from('campaign_guests').delete().eq('campaign_id', g.campaign_id).eq('email', g.email), `Removed ${g.email}.`)}>
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
        <form className="inline-form" onSubmit={e => {
          e.preventDefault();
          if (!guest.campaign) return setMsg('Choose a campaign first.');
          run(supabase.from('campaign_guests').insert({ email: guest.email.trim().toLowerCase(), campaign_id: guest.campaign }), `Added ${guest.email} as a guest.`);
          setGuest({ email: '', campaign: null });
        }}>
          <input type="email" required placeholder="name@example.org" value={guest.email} onChange={e => setGuest(g => ({ ...g, email: e.target.value }))} />
          <SearchSelect value={guest.campaign} options={campaigns} onChange={v => setGuest(g => ({ ...g, campaign: v }))} placeholder="Campaign…" />
          <button className="btn primary">Add guest</button>
        </form>

        <h2>Admin emails</h2>
        <ul className="plain">
          {(admins.data ?? []).map(a => (
            <li key={a.email}>
              {a.email}{' '}
              {canManageAdmins && (
                <button className="icon-btn" title="Remove" onClick={() => run(supabase.from('admin_emails').delete().eq('email', a.email), `Removed ${a.email}.`)}>
                  <Trash2 size={14} />
                </button>
              )}
            </li>
          ))}
        </ul>
        {canManageAdmins ? (
          <>
            <form className="inline-form" onSubmit={e => {
              e.preventDefault();
              run(supabase.from('admin_emails').insert({ email: newAdmin.trim().toLowerCase() }), `${newAdmin} is now listed as an admin.`);
              setNewAdmin('');
            }}>
              <input type="email" required placeholder="name@example.org" value={newAdmin} onChange={e => setNewAdmin(e.target.value)} />
              <button className="btn primary">Add admin email</button>
            </form>
            <p className="muted">Anyone with this email becomes an admin here, straight away if they already have a login. Removing an email doesn't change an existing login's role; do that above.</p>
          </>
        ) : <p className="muted">Only the Super Admin can add admins.</p>}
      </div>
    </section>
  );
}
