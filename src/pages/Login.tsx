import { PoweredBy } from '../components/PoweredBy';
import { useRef, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { EmailOtpType } from '@supabase/supabase-js';
import { OrgLogo, ProductLockup } from '../components/Layout';
import { useAuth } from '../lib/auth';
import { startFreshSession } from '../lib/idle';
import { signInWithPassword, supabase } from '../lib/supabase';

type Mode = 'signin' | 'signup' | 'reset';

/*
 * Sign in with Google (Moshe, approved by Shulim, 2026-11-16). The button shows only once Google is turned on in
 * Supabase Auth, where its client ID and secret live (never in this code). After Google, the same two-step check as a
 * password sign-in applies: anyone with text or call codes (or an authenticator) set up is asked for a code.
 */
const GOOGLE_FLAG = 'google-signin';
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

/** Whether Google sign-in is turned on in Supabase Auth (its public settings say so). */
export async function googleEnabled(): Promise<boolean> {
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/settings`, { headers: { apikey: SUPABASE_KEY } });
    if (!res.ok) return false;
    return !!(await res.json())?.external?.google;
  } catch { return false; }
}

export async function signInWithGoogle(): Promise<string | null> {
  try { sessionStorage.setItem(GOOGLE_FLAG, '1'); } catch { /* private window */ }
  // As for a password sign-in: an old activity time mustn't sign the new session straight back out.
  startFreshSession();
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin + import.meta.env.BASE_URL, queryParams: { prompt: 'select_account' } },
  });
  return error ? error.message : null;
}

/** True once, right after coming back from Google. */
function cameBackFromGoogle() {
  try { const v = sessionStorage.getItem(GOOGLE_FLAG) === '1'; sessionStorage.removeItem(GOOGLE_FLAG); return v; } catch { return false; }
}

/** New passwords: at least 12 characters (Shulim, 2026-11-11). Existing shorter passwords still sign in until changed. */
export const MIN_PASSWORD = 12;
export const passwordProblem = (p: string) =>
  p.length >= MIN_PASSWORD && /\d/.test(p) && /[^A-Za-z0-9]/.test(p)
    ? null
    : `Use at least ${MIN_PASSWORD} characters, including a number and a special character.`;

/**
 * The sign-in, password and waiting screens: the Donor Base sign-in design (brand kit splash-login, Shulim 2026-11-22),
 * always dark: the endorsed lockup, then the form. An organization's own logo and name show under the lockup.
 */
export function AuthShell({ children }: { children: ReactNode }) {
  const { org } = useAuth();
  return (
    <div className="auth">
      <div className="auth-brand">
        <ProductLockup endorsed dark />
        {org && <div className="auth-org"><OrgLogo org={org} /><span>{org.name}</span></div>}
      </div>
      <div className="auth-main">{children}</div>
      <footer className="auth-foot"><PoweredBy orgId={org?.id} /><a href="https://trubase.org" target="_blank" rel="noopener noreferrer">trubase.org</a></footer>
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
  // Said once, after an automatic sign-out for inactivity.
  const [idleNote, setIdleNote] = useState(() => { try { const v = sessionStorage.getItem('signed-out-idle') === '1'; sessionStorage.removeItem('signed-out-idle'); return v; } catch { return false; } });
  // If a sign-in succeeds but this page is still showing a few seconds later, say so instead of silently resetting.
  const stuck = useRef<number | null>(null);
  useEffect(() => () => { if (stuck.current) window.clearTimeout(stuck.current); }, []);
  const { org } = useAuth();
  const [fromGoogle] = useState(cameBackFromGoogle);
  const googleError = !!linkError && fromGoogle;
  const [google, setGoogle] = useState(false);
  useEffect(() => { void googleEnabled().then(setGoogle); }, []);
  const [mode, setMode] = useState<Mode>(linkError && !googleError ? 'reset' : 'signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(
    googleError ? { ok: false, text: `Google sign-in didn't finish (${linkError}). Try again, or sign in with your email and password.` }
      : linkError ? { ok: false, text: 'That link has expired or was already used. Enter your email to get a new one.' } : null,
  );

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (mode === 'signup' && passwordProblem(password)) return setMsg({ ok: false, text: passwordProblem(password)! });
    setBusy(true);
    setMsg(null);
    setIdleNote(false);
    const redirectTo = window.location.origin + import.meta.env.BASE_URL;
    let error;
    if (mode === 'signin') {
      ({ error } = await signInWithPassword(email, password));
      if (!error) {
        stuck.current = window.setTimeout(() => setMsg({ ok: false, text: 'Your password was accepted, but Donor Base couldn’t open your session. Refresh the page and sign in again; if it keeps happening, tell the office.' }), 5000);
      }
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
            <input type="password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} minLength={mode === 'signup' ? MIN_PASSWORD : undefined} required
                   value={password} onChange={e => setPassword(e.target.value)} placeholder={mode === 'signup' ? `At least ${MIN_PASSWORD} characters` : ''} />
          </label>
        )}
        {msg && <div className={msg.ok ? 'notice' : 'error'}>{msg.text}</div>}
        {idleNote && !msg && <div className="notice">You were signed out after 30 minutes without activity.</div>}
        <button className="btn primary wide" disabled={busy}>
          {busy ? 'Please wait…' : mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create login' : 'Send reset link'}
        </button>
        {mode === 'signin' && google && (
          <>
            <div className="auth-or"><span>or</span></div>
            <button type="button" className="btn wide google-btn" disabled={busy} onClick={async () => {
              setBusy(true); setMsg(null);
              const problem = await signInWithGoogle();
              if (problem) { setMsg({ ok: false, text: problem }); setBusy(false); }
            }}>
              <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>
              Sign in with Google
            </button>
            <p className="muted small">If you have text or call codes set up, you'll still be asked for a code after Google.</p>
          </>
        )}
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
          <input type="password" minLength={MIN_PASSWORD} required autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} />
        </label>
        {err && <div className="error">{err}</div>}
        <button className="btn primary wide">Save password</button>
      </form>
    </AuthShell>
  );
}
