import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import SearchSelect from '../components/SearchSelect';
import { StatusPill } from '../components/Pill';
import { supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';
import { managerOptions, type Option } from '../lib/lookups';
import { dateTime } from '../lib/format';
import { useAuth } from '../lib/auth';

export default function UsersPage() {
  const { profile: me } = useAuth();
  const [managers, setManagers] = useState<Option[]>([]);
  const [newAdmin, setNewAdmin] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => { managerOptions().then(setManagers); }, []);

  const users = useQuery(async () => {
    const [{ data: members, error }, { data: profiles }, { data: links }, { data: locked }] = await Promise.all([
      supabase.from('org_members').select('*').order('created_at'),
      supabase.from('profiles').select('*'),
      supabase.from('user_managers').select('*'),
      supabase.rpc('locked_accounts'),
    ]);
    if (error) throw new Error(error.message);
    return (members ?? []).map(m => ({
      ...m,
      email: (profiles ?? []).find(p => p.user_id === m.user_id)?.email,
      managers: (links ?? []).filter(l => l.user_id === m.user_id).map(l => l.manager_id),
      lockedUntil: ((locked ?? []) as Row[]).find(l => l.user_id === m.user_id)?.locked_until,
    }));
  });

  const admins = useQuery(async () => (await supabase.from('admin_emails').select('*').order('email')).data ?? []);

  async function run(p: PromiseLike<{ error: { message: string } | null }>, ok: string) {
    const { error } = await p;
    setMsg(error ? `Error: ${error.message}` : ok);
    users.reload();
    admins.reload();
  }

  const setRole = (u: Row, role: string) =>
    run(supabase.from('org_members').update({ role }).eq('user_id', u.user_id), `${u.email} is now ${role}.`);
  const unlock = (u: Row) =>
    run(supabase.rpc('unlock_account', { p_user: u.user_id }), `${u.email} can sign in again.`);
  const link = (u: Row, managerId: string) =>
    run(supabase.from('user_managers').insert({ user_id: u.user_id, manager_id: managerId }), `Linked manager to ${u.email}.`);
  const unlink = (u: Row, managerId: string) =>
    run(supabase.from('user_managers').delete().eq('user_id', u.user_id).eq('manager_id', managerId), `Unlinked manager from ${u.email}.`);

  const label = (id: string) => managers.find(m => m.value === id)?.label ?? id;

  return (
    <section className="view">
      <div className="view-head">
        <div className="view-title"><h1>Users &amp; Access</h1><span className="count">Who can sign in and what they can see</span></div>
      </div>
      <div>
        <p className="muted">
          People create their own login on the sign-in page. Emails listed under <b>Admin emails</b> become admins automatically.
          Anyone whose email matches a <b>Manager</b> record becomes a campaign manager and only sees campaigns where they are the
          manager or a sub-manager. Everyone else waits as <b>pending</b> until you assign a role here.
        </p>
        {msg && <div className="notice">{msg}</div>}

        <h2>Logins</h2>
        <div className="table-card"><div className="table-wrap">
          <table className="grid">
            <thead><tr><th>Email</th><th>Role</th><th>Linked manager records</th><th>Created</th></tr></thead>
            <tbody>
              {(users.data ?? []).map(u => (
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
                    <StatusPill value={u.role} />{" "}
                    <select value={u.role} disabled={u.user_id === me?.user_id} onChange={e => setRole(u, e.target.value)}>
                      <option value="pending">pending</option>
                      <option value="manager">manager</option>
                      <option value="admin">admin</option>
                    </select>
                  </td>
                  <td>
                    <div className="multi">
                      {u.managers.map((m: string) => (
                        <span className="chip" key={m}>{label(m)}<button onClick={() => unlink(u, m)}><Trash2 size={12} /></button></span>
                      ))}
                      {u.role === 'manager' && (
                        <SearchSelect value={null} options={managers.filter(m => !u.managers.includes(m.value))}
                                      onChange={v => v && link(u, v)} placeholder="Link manager…" />
                      )}
                    </div>
                  </td>
                  <td>{dateTime(u.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div></div>

        <h2>Admin emails</h2>
        <ul className="plain">
          {(admins.data ?? []).map(a => (
            <li key={a.email}>
              {a.email}{' '}
              <button className="icon-btn" title="Remove" onClick={() => run(supabase.from('admin_emails').delete().eq('email', a.email), `Removed ${a.email}.`)}>
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
        <form className="inline-form" onSubmit={e => {
          e.preventDefault();
          run(supabase.from('admin_emails').insert({ email: newAdmin.trim().toLowerCase() }), `${newAdmin} is now listed as an admin.`);
          setNewAdmin('');
        }}>
          <input type="email" required placeholder="name@example.org" value={newAdmin} onChange={e => setNewAdmin(e.target.value)} />
          <button className="btn primary">Add admin email</button>
        </form>
        <p className="muted">Anyone with this email becomes an admin here, straight away if they already have a login. Removing an email doesn't change an existing login's role; do that above.</p>
      </div>
    </section>
  );
}
