import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import SearchSelect from '../components/SearchSelect';
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
    const [{ data: profiles, error }, { data: links }] = await Promise.all([
      supabase.from('profiles').select('*').order('created_at'),
      supabase.from('user_managers').select('*'),
    ]);
    if (error) throw new Error(error.message);
    return (profiles ?? []).map(p => ({ ...p, managers: (links ?? []).filter(l => l.user_id === p.user_id).map(l => l.manager_id) }));
  });

  const admins = useQuery(async () => (await supabase.from('admin_emails').select('*').order('email')).data ?? []);

  async function run(p: PromiseLike<{ error: { message: string } | null }>, ok: string) {
    const { error } = await p;
    setMsg(error ? `Error: ${error.message}` : ok);
    users.reload();
    admins.reload();
  }

  const setRole = (u: Row, role: string) =>
    run(supabase.from('profiles').update({ role }).eq('user_id', u.user_id), `${u.email} is now ${role}.`);
  const link = (u: Row, managerId: string) =>
    run(supabase.from('user_managers').insert({ user_id: u.user_id, manager_id: managerId }), `Linked manager to ${u.email}.`);
  const unlink = (u: Row, managerId: string) =>
    run(supabase.from('user_managers').delete().eq('user_id', u.user_id).eq('manager_id', managerId), `Unlinked manager from ${u.email}.`);

  const label = (id: string) => managers.find(m => m.value === id)?.label ?? id;

  return (
    <section className="view">
      <div className="view-head"><h1>Users &amp; Access</h1></div>
      <div className="pad">
        <p className="muted">
          People create their own login on the sign-in page. Emails listed under <b>Admin emails</b> become admins automatically.
          Anyone whose email matches a <b>Manager</b> record becomes a campaign manager and only sees campaigns where they are the
          manager or a sub-manager. Everyone else waits as <b>pending</b> until you assign a role here.
        </p>
        {msg && <div className="notice">{msg}</div>}

        <h2>Logins</h2>
        <div className="table-wrap">
          <table className="grid">
            <thead><tr><th>Email</th><th>Role</th><th>Linked manager records</th><th>Created</th></tr></thead>
            <tbody>
              {(users.data ?? []).map(u => (
                <tr key={u.user_id}>
                  <td>{u.email}</td>
                  <td>
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
        </div>

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
          run(supabase.from('admin_emails').insert({ email: newAdmin.trim().toLowerCase() }), `${newAdmin} will become admin on sign-up.`);
          setNewAdmin('');
        }}>
          <input type="email" required placeholder="name@example.org" value={newAdmin} onChange={e => setNewAdmin(e.target.value)} />
          <button className="btn primary">Add admin email</button>
        </form>
        <p className="muted">Adding an email here only affects future sign-ups; for an existing login, change its role above.</p>
      </div>
    </section>
  );
}
