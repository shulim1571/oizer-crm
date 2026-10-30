import { useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';

type Mode = 'signin' | 'signup' | 'reset';

export default function Login() {
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const redirectTo = window.location.origin + import.meta.env.BASE_URL;
    let error;
    if (mode === 'signin') {
      ({ error } = await supabase.auth.signInWithPassword({ email, password }));
    } else if (mode === 'signup') {
      const res = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: redirectTo } });
      error = res.error;
      if (!error && !res.data.session) setMsg({ ok: true, text: 'Check your email to confirm your address, then sign in.' });
    } else {
      ({ error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo }));
      if (!error) setMsg({ ok: true, text: 'If that email has a login, a reset link is on its way.' });
    }
    if (error) setMsg({ ok: false, text: error.message });
    setBusy(false);
  }

  return (
    <div className="login">
      <form className="card login-card" onSubmit={submit}>
        <div className="brand big">Oizer</div>
        <h2>{mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create login' : 'Reset password'}</h2>
        <label className="field"><span>Email</span>
          <input type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} />
        </label>
        {mode !== 'reset' && (
          <label className="field"><span>Password</span>
            <input type="password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} minLength={8} required
                   value={password} onChange={e => setPassword(e.target.value)} />
          </label>
        )}
        {msg && <div className={msg.ok ? 'notice' : 'error'}>{msg.text}</div>}
        <button className="btn primary wide" disabled={busy}>
          {busy ? 'Please wait…' : mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create login' : 'Send reset link'}
        </button>
        <div className="login-links">
          {mode !== 'signin' && <button type="button" className="link" onClick={() => setMode('signin')}>Back to sign in</button>}
          {mode === 'signin' && <button type="button" className="link" onClick={() => setMode('signup')}>First time? Create a login</button>}
          {mode === 'signin' && <button type="button" className="link" onClick={() => setMode('reset')}>Forgot password?</button>}
        </div>
        {mode === 'signup' && (
          <p className="muted small">Use the email the office has on file for you as a campaign manager. Other emails wait for an admin to grant access.</p>
        )}
      </form>
    </div>
  );
}

export function SetNewPassword({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="login">
      <form className="card login-card" onSubmit={async e => {
        e.preventDefault();
        const { error } = await supabase.auth.updateUser({ password });
        if (error) setErr(error.message); else onDone();
      }}>
        <h2>Choose a new password</h2>
        <label className="field"><span>New password</span>
          <input type="password" minLength={8} required autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} />
        </label>
        {err && <div className="error">{err}</div>}
        <button className="btn primary wide">Save password</button>
      </form>
    </div>
  );
}
