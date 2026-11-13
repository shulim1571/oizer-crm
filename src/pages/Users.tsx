import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Trash2, X } from 'lucide-react';
import { ROLE_LABEL } from '../components/Layout';
import RowMenu from '../components/RowMenu';
import SearchSelect from '../components/SearchSelect';
import { Pill, StatusPill } from '../components/Pill';
import { supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';
import { campaignOptions, managerOptions, type Option } from '../lib/lookups';
import { dateTime } from '../lib/format';
import { useAuth } from '../lib/auth';

// Users & Access, in four tabs: who signs in (and their role), what admins may do beyond the usual, campaign
// guests, and the emails that become admins on their own. The tab is in the address (?tab=), so it can be linked.

const PERMISSION_GROUPS: { group: string; items: { key: string; short: string; full: string }[] }[] = [
  { group: 'People', items: [
    { key: 'manage_admins', short: 'Admins', full: 'Add, remove and change admin accounts' },
    { key: 'grant_overrides', short: 'Overrides', full: 'Grant fundraisers overrides (such as spending past their balance)' },
  ] },
  { group: 'Campaigns & data', items: [
    { key: 'reopen_campaigns', short: 'Reopen', full: 'Reopen closed campaigns' },
    { key: 'run_imports', short: 'Import', full: 'Run bulk imports' },
    { key: 'reverse_imports', short: 'Undo import', full: 'Reverse bulk imports' },
  ] },
  { group: 'Money & integrations', items: [
    { key: 'configure_fees', short: 'Fees', full: 'Configure processing fees' },
    { key: 'change_default_bank', short: 'Default bank', full: 'Change the default bank account' },
    { key: 'manage_api_keys', short: 'API keys', full: 'Create and revoke API keys' },
  ] },
];

const TABS = [['users', 'Users'], ['permissions', 'Permissions'], ['guests', 'Guests'], ['admin-emails', 'Admin emails']] as const;
type Tab = typeof TABS[number][0];
const MEMBER_STATUS: Record<string, string> = { suspended: 'Suspended', deactivated: 'Deactivated' };
const ROLE_HELP: Record<string, string> = {
  pending: 'Signed up but sees nothing until given a role.',
  manager: 'Sees only campaigns where a linked fundraiser record is the Primary or a Secondary Fundraiser.',
  guest: 'Follows one campaign read-only (set on the Guests tab).',
  admin: 'Sees and manages everything in this organization.',
  super_admin: 'Everything an admin can do, plus keys, integrations and other admins.',
};

export default function UsersPage() {
  const { profile: me, isSuperAdmin, permissions } = useAuth();
  const canManageAdmins = permissions.includes('manage_admins');
  const [params, setParams] = useSearchParams();
  const tab = (TABS.some(([k]) => k === params.get('tab')) ? params.get('tab') : 'users') as Tab;
  const setTab = (t: Tab) => setParams(t === 'users' ? {} : { tab: t }, { replace: true });
  const [managers, setManagers] = useState<Option[]>([]);
  const [campaigns, setCampaigns] = useState<Option[]>([]);
  const [newAdmin, setNewAdmin] = useState('');
  const [guest, setGuest] = useState<{ email: string; campaign: string | null }>({ email: '', campaign: null });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [openUser, setOpenUser] = useState<string | null>(null);

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
    setMsg(error ? { ok: false, text: error.message } : { ok: true, text: ok });
    users.reload();
    admins.reload();
    guests.reload();
  }

  const setRole = (u: Row, role: string) =>
    run(supabase.from('org_members').update({ role }).eq('user_id', u.user_id), `${u.email} is now ${ROLE_LABEL[role]}.`);
  const unlock = (u: Row) => run(supabase.rpc('unlock_account', { p_user: u.user_id }), `${u.email} can sign in again.`);
  const link = (u: Row, managerId: string) =>
    run(supabase.from('user_managers').insert({ user_id: u.user_id, manager_id: managerId }), `Linked a fundraiser record to ${u.email}.`);
  const unlink = (u: Row, managerId: string) =>
    run(supabase.from('user_managers').delete().eq('user_id', u.user_id).eq('manager_id', managerId), `Unlinked a fundraiser record from ${u.email}.`);
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
  const list = (users.data ?? []) as Row[];
  const regularAdmins = list.filter(u => u.role === 'admin');
  const pending = list.filter(u => u.role === 'pending').length;
  const selected = list.find(u => u.user_id === openUser) ?? null;
  const canEdit = (u: Row) => u.user_id !== me?.user_id && u.role !== 'super_admin' && (u.role !== 'admin' || canManageAdmins);

  const needs = (u: Row) =>
    u.role === 'manager' && u.managers.length === 0 ? 'No fundraiser record linked'
      : u.role === 'guest' && !(guests.data ?? []).some(g => g.email === u.email?.toLowerCase()) ? 'Not on a campaign yet'
        : u.role === 'pending' ? 'Waiting for a role' : null;

  return (
    <section className="view">
      <div className="view-head">
        <div className="view-title"><h1>Users &amp; Access</h1><span className="count">Who can sign in and what they can see</span></div>
      </div>
      <div className="tabs" role="tablist">
        {TABS.filter(([k]) => k !== 'permissions' || isSuperAdmin).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
            {l}{k === 'users' && pending > 0 ? ` (${pending} waiting)` : ''}
          </button>
        ))}
      </div>
      {msg && <div className={msg.ok ? 'notice' : 'error'}>{msg.text}</div>}
      {users.error && <div className="error">{users.error}</div>}

      {tab === 'users' && (
        <>
          <p className="muted small">People create their own login on the sign-in page and wait as <b>Pending</b> until given a role here. Click a person to change their role or fundraiser records.</p>
          {selected && (
            <div className="panel-box user-panel">
              <h2>{selected.email} <button className="icon-btn" aria-label="Close" onClick={() => setOpenUser(null)}><X size={16} /></button></h2>
              <div className="user-panel-grid">
                <div>
                  <h3>Role</h3>
                  {canEdit(selected) ? (
                    <select value={selected.role} onChange={e => setRole(selected, e.target.value)}>
                      <option value="pending">Pending</option>
                      <option value="manager">Fundraiser</option>
                      <option value="guest">Community Guest</option>
                      {canManageAdmins && <option value="admin">Admin</option>}
                    </select>
                  ) : <StatusPill value={ROLE_LABEL[selected.role]} />}
                  <p className="muted small">{ROLE_HELP[selected.role]}</p>
                </div>
                {selected.role === 'manager' && (
                  <div>
                    <h3>Fundraiser records</h3>
                    <div className="multi">
                      {selected.managers.map((m: string) => (
                        <span className="chip" key={m}>{label(m)}<button aria-label={`Unlink ${label(m)}`} onClick={() => unlink(selected, m)}><Trash2 size={12} /></button></span>
                      ))}
                      {selected.managers.length === 0 && <span className="muted small">None yet: they see nothing until one is linked.</span>}
                    </div>
                    <SearchSelect value={null} options={managers.filter(m => !selected.managers.includes(m.value))}
                      onChange={v => v && link(selected, v)} placeholder="Link a fundraiser record…" />
                  </div>
                )}
                <div>
                  <h3>Account</h3>
                  <p className="muted small">
                    {MEMBER_STATUS[selected.status] ?? 'Active'}{selected.lockedUntil ? ` · locked until ${dateTime(selected.lockedUntil)}` : ''}
                    {' · '}last sign-in {dateTime(selected.last_login_at) || 'never'}
                  </p>
                  <div className="multi">
                    {selected.lockedUntil && <button className="btn" onClick={() => unlock(selected)}>Unlock</button>}
                    {canEdit(selected) && (selected.status === 'active'
                      ? <button className="btn danger" onClick={() => setStatus(selected, 'suspended')}>Suspend</button>
                      : <button className="btn" onClick={() => setStatus(selected, 'active')}>Reinstate</button>)}
                    {isSuperAdmin && selected.role === 'admin' && selected.user_id !== me?.user_id &&
                      <button className="btn" onClick={() => transfer(selected)}>Make Super Admin</button>}
                  </div>
                </div>
              </div>
            </div>
          )}
          <div className="table-card"><div className="table-wrap">
            <table className="grid">
              <thead><tr><th>Person</th><th>Role</th><th>Status</th><th>Fundraiser records</th><th>Last sign-in</th><th /></tr></thead>
              <tbody>
                {list.map(u => (
                  <tr key={u.user_id} className={`clickable ${openUser === u.user_id ? 'selected' : ''}`} onClick={() => setOpenUser(u.user_id)}>
                    <td>{u.email}{u.user_id === me?.user_id && <span className="muted small"> (you)</span>}
                      {needs(u) && <div className="muted small">{needs(u)}</div>}</td>
                    <td><StatusPill value={ROLE_LABEL[u.role]} /></td>
                    <td>{u.lockedUntil ? <Pill tone="red">Locked</Pill> : MEMBER_STATUS[u.status] ? <StatusPill value={MEMBER_STATUS[u.status]} /> : <span className="muted">Active</span>}</td>
                    <td>{u.role === 'manager' ? (u.managers.length ? u.managers.map(label).join(', ') : <span className="muted">—</span>) : <span className="muted">—</span>}</td>
                    <td>{dateTime(u.last_login_at) || <span className="muted">Never</span>}</td>
                    <td>
                      <RowMenu items={[
                        { label: 'Change role or records…', onClick: () => setOpenUser(u.user_id) },
                        { label: 'Unlock', onClick: () => unlock(u), hidden: !u.lockedUntil },
                        { label: 'Suspend', onClick: () => setStatus(u, 'suspended'), hidden: !canEdit(u) || u.status !== 'active', danger: true },
                        { label: 'Reinstate', onClick: () => setStatus(u, 'active'), hidden: !canEdit(u) || u.status === 'active' },
                        { label: 'Make Super Admin', onClick: () => transfer(u), hidden: !(isSuperAdmin && u.role === 'admin' && u.user_id !== me?.user_id) },
                      ]} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div></div>
        </>
      )}

      {tab === 'permissions' && isSuperAdmin && (
        <>
          <p className="muted small">Super Admin powers you can give to individual admins. Hover a heading for what it allows.</p>
          {regularAdmins.length === 0 ? <div className="panel-box muted small">There are no other admins yet. Give someone the Admin role on the Users tab first.</div> : (
            <div className="table-card"><div className="table-wrap">
              <table className="grid perm-grid">
                <thead>
                  <tr><th rowSpan={2}>Admin</th>{PERMISSION_GROUPS.map(g => <th key={g.group} colSpan={g.items.length} className="perm-group">{g.group}</th>)}</tr>
                  <tr>{PERMISSION_GROUPS.flatMap(g => g.items.map(i => <th key={i.key} title={i.full} className="perm-head">{i.short}</th>))}</tr>
                </thead>
                <tbody>
                  {regularAdmins.map(u => (
                    <tr key={u.user_id}>
                      <td>{u.email}</td>
                      {PERMISSION_GROUPS.flatMap(g => g.items.map(i => (
                        <td key={i.key} className="perm-cell">
                          <input type="checkbox" aria-label={`${i.full} for ${u.email}`} title={i.full} checked={u.delegated.includes(i.key)}
                            onChange={e => delegate(u, i.key, e.target.checked)} />
                        </td>
                      )))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div></div>
          )}
        </>
      )}

      {tab === 'guests' && (
        <>
          <p className="muted small">A Community Guest follows one campaign read-only: donor names, amounts, method and date. Invitation emails aren't sent yet, so tell them to create a login with this email.</p>
          <form className="inline-form" onSubmit={e => {
            e.preventDefault();
            if (!guest.campaign) return setMsg({ ok: false, text: 'Choose a campaign first.' });
            run(supabase.from('campaign_guests').insert({ email: guest.email.trim().toLowerCase(), campaign_id: guest.campaign }), `Added ${guest.email} as a guest.`);
            setGuest({ email: '', campaign: null });
          }}>
            <input type="email" required placeholder="name@example.org" value={guest.email} onChange={e => setGuest(g => ({ ...g, email: e.target.value }))} />
            <SearchSelect value={guest.campaign} options={campaigns} onChange={v => setGuest(g => ({ ...g, campaign: v }))} placeholder="Campaign…" />
            <button className="btn primary">Add guest</button>
          </form>
          <div className="table-card"><div className="table-wrap">
            <table className="grid">
              <thead><tr><th>Email</th><th>Campaign</th><th>Added</th><th /></tr></thead>
              <tbody>
                {(guests.data ?? []).length === 0 && <tr><td colSpan={4} className="muted">No guests yet.</td></tr>}
                {(guests.data ?? []).map(g => (
                  <tr key={`${g.campaign_id}-${g.email}`}>
                    <td>{g.email}</td><td>{campaignLabel(g.campaign_id)}</td><td>{dateTime(g.added_at)}</td>
                    <td><RowMenu items={[{ label: 'Remove guest', danger: true, onClick: () => run(supabase.from('campaign_guests').delete().eq('campaign_id', g.campaign_id).eq('email', g.email), `Removed ${g.email}.`) }]} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div></div>
        </>
      )}

      {tab === 'admin-emails' && (
        <>
          <p className="muted small">
            An admin email gives the <b>Admin</b> role automatically: right away if that person already has a login, otherwise when they sign up.
            It doesn't hold the role afterwards. Removing an email leaves their role as it is; change roles on the Users tab.
          </p>
          {canManageAdmins ? (
            <form className="inline-form" onSubmit={e => {
              e.preventDefault();
              run(supabase.from('admin_emails').insert({ email: newAdmin.trim().toLowerCase() }), `${newAdmin} is now listed as an admin.`);
              setNewAdmin('');
            }}>
              <input type="email" required placeholder="name@example.org" value={newAdmin} onChange={e => setNewAdmin(e.target.value)} />
              <button className="btn primary">Add admin email</button>
            </form>
          ) : <p className="muted small">Only the Super Admin (or an admin allowed to manage admins) can add admin emails.</p>}
          <div className="table-card"><div className="table-wrap">
            <table className="grid">
              <thead><tr><th>Email</th><th>Has a login</th><th /></tr></thead>
              <tbody>
                {(admins.data ?? []).length === 0 && <tr><td colSpan={3} className="muted">None.</td></tr>}
                {(admins.data ?? []).map(a => {
                  const login = list.find(u => u.email?.toLowerCase() === a.email);
                  return (
                    <tr key={a.email}>
                      <td>{a.email}</td>
                      <td>{login ? <>Yes · <StatusPill value={ROLE_LABEL[login.role]} /></> : <span className="muted">Not yet</span>}</td>
                      <td>{canManageAdmins && <RowMenu items={[{ label: 'Remove admin email', danger: true, onClick: () => run(supabase.from('admin_emails').delete().eq('email', a.email), `Removed ${a.email}.`) }]} />}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div></div>
        </>
      )}
    </section>
  );
}
