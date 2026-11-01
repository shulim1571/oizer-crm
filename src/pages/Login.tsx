import { useState, type FormEvent, type ReactNode } from 'react';
import type { EmailOtpType } from '@supabase/supabase-js';
import { OrgLogo } from '../components/Layout';
import { useAuth } from '../lib/auth';
import { signInWithPassword, supabase } from '../lib/supabase';

type Mode = 'signin' | 'signup' | 'reset';

const passwordProblem = (p: string) =>
  p.length >= 8 && /\d/.test(p) && /[^A-Za-z0-9]/.test(p)
    ? null
    : 'Use at least 8 characters, including a number and a special character.';

/** Two-panel layout shared by the sign-in, password and waiting screens. */
export function AuthShell({ children }: { children: ReactNode }) {
  const { org } = useAuth();
  return (
    <div className="auth">
      <div className="auth-art">
        <div className="logo-row">
          <OrgLogo org={org} />
          <div className="logo-text">{org?.name ?? 'Campaign CRM'}{org && <small style={{ color: 'rgba(255,255,255,.7)' }}>Campaign CRM</small>}</div>
        </div>
        <div>
          <h2>Every campaign, donor and dollar in one place.</h2>
          <p>Track what each campaign raised, what it spent and who gave.</p>
        </div>
        <div className="auth-stats">
          <div><b>Live</b><span>balances</span></div>
          <div><b>Secure</b><span>role-based access</span></div>
          <div><b>Anywhere</b><span>desktop &amp; phone</span></div>
        </div>
      </div>
      <div className="auth-main">{children}</div>
    </div>
  );
}

/** What an emailed link came back with: a token to use, or Supabase's reason for refusing it. */
export function readEmailLink() {
  const params = new URLSearchParams(window.location.search);
  const error = params.get('error_description');
  if (error) window.history.replaceState(null, '', window.location.pathname);
  return { tokenHash: params.get('token_hash'), type: params.get('type') as EmailOtpType | null, error };
}

/**
 * Email links carry a token we redeem here instead of the usual sign-in code, for two reasons: it
 * works in any browser, not only the one that asked for the email, and it needs a click, so mail
 * scanners that open every link can't use it up first.
 */
export function ConfirmEmailLink({ tokenHash, type, onDone }: { tokenHash: string; type: EmailOtpType; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const clear = () => {
    window.history.replaceState(null, '', window.location.pathname);
    onDone();
  };
  return (
    <AuthShell>
      <div className="auth-card">
        <h1>{type === 'recovery' ? 'Reset your password' : 'Confirm your email'}</h1>
        <p className="lead">Continue to finish this. The link works once.</p>
        {err && <div className="error">{err}</div>}
        {err
          ? <button className="btn primary wide" onClick={clear}>Back to sign in</button>
          : (
            <button className="btn primary wide" disabled={busy} onClick={async () => {
              setBusy(true);
              const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
              setBusy(false);
              if (error) setErr('That link has expired or was already used. Request a new one from the sign-in page.');
              else clear();
            }}>{busy ? 'Please wait…' : 'Continue'}</button>
          )}
      </div>
    </AuthShell>
  );
}

export default function Login({ linkError }: { linkError?: string | null }) {
  const { org } = useAuth();
  const [mode, setMode] = useState<Mode>(linkError ? 'reset' : 'signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(
    linkError ? { ok: false, text: 'That link has expired or was already used. Enter your email to get a new one.' } : null,
  );

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (mode === 'signup' && passwordProblem(password)) return setMsg({ ok: false, text: passwordProblem(password)! });
    setBusy(true);
    setMsg(null);
    const redirectTo = window.location.origin + import.meta.env.BASE_URL;
    let error;
    if (mode === 'signin') {
      ({ error } = await signInWithPassword(email, password));
    } else if (mode === 'signup') {
      const res = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: redirectTo, data: { org_slug: org?.slug } } });
      error = res.error;
      // Supabase answers the same way for an email that already has a login, and sends nothing.
      if (!error && !res.data.session) setMsg({ ok: true, text: 'Check your email to confirm your address, then sign in. If no email arrives, you may already have a login: sign in, or use Forgot password.' });
    } else {
      ({ error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo }));
      if (!error) setMsg({ ok: true, text: 'If that email has a login, a reset link is on its way.' });
    }
    if (error) setMsg({ ok: false, text: error.message });
    setBusy(false);
  }

  const heading = { signin: 'Welcome back', signup: 'Create your login', reset: 'Reset your password' }[mode];
  const lead = {
    signin: 'Sign in to manage campaigns and donations.',
    signup: 'Use the email the office has on file for you.',
    reset: "We'll email you a link to choose a new password.",
  }[mode];

  return (
    <AuthShell>
      <form className="auth-card" onSubmit={submit}>
        <h1>{heading}</h1>
        <p className="lead">{lead}</p>
        <label className="field"><span>Email</span>
          <input type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.org" />
        </label>
        {mode !== 'reset' && (
          <label className="field"><span>Password</span>
            <input type="password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} minLength={8} required
                   value={password} onChange={e => setPassword(e.target.value)} placeholder="At least 8 characters" />
          </label>
        )}
        {msg && <div className={msg.ok ? 'notice' : 'error'}>{msg.text}</div>}
        <button className="btn primary wide" disabled={busy}>
          {busy ? 'Please wait…' : mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create login' : 'Send reset link'}
        </button>
        <div className="auth-links">
          {mode !== 'signin' && <button type="button" className="link" onClick={() => setMode('signin')}>Back to sign in</button>}
          {mode === 'signin' && <button type="button" className="link" onClick={() => setMode('signup')}>First time? Create a login</button>}
          {mode === 'signin' && <button type="button" className="link" onClick={() => setMode('reset')}>Forgot password?</button>}
        </div>
        {mode === 'signup' && (
          <p className="muted small">Fundraisers are matched by email automatically. Other emails wait for an admin to grant access.</p>
        )}
      </form>
    </AuthShell>
  );
}

export function SetNewPassword({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <AuthShell>
      <form className="auth-card" onSubmit={async e => {
        e.preventDefault();
        if (passwordProblem(password)) return setErr(passwordProblem(password));
        const { error } = await supabase.auth.updateUser({ password });
        if (error) setErr(error.message); else onDone();
      }}>
        <h1>Choose a new password</h1>
        <p className="lead">You'll use it next time you sign in.</p>
        <label className="field"><span>New password</span>
          <input type="password" minLength={8} required autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} />
        </label>
        {err && <div className="error">{err}</div>}
        <button className="btn primary wide">Save password</button>
      </form>
    </AuthShell>
  );
}
