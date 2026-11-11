import { useState, type FormEvent } from 'react';
import { ShieldCheck } from 'lucide-react';
import { Pill } from '../components/Pill';
import { useAuth } from '../lib/auth';
import { useMfa, verifyCode } from '../lib/mfa';
import { supabase } from '../lib/supabase';

// Account security: set up two-step verification with an authenticator app (Shulim, 2026-11-11).

/** Enter a code to verify this session. */
export function CodePrompt({ factorId, onDone, onSkip, intro }: { factorId: string; onDone: () => void; onSkip?: () => void; intro?: string }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const problem = await verifyCode(factorId, code);
    setBusy(false);
    if (problem) return setError(problem);
    onDone();
  }
  return (
    <form className="mfa-prompt" onSubmit={submit}>
      <p className="muted">{intro ?? 'Enter the 6-digit code from your authenticator app.'}</p>
      <div className="mfa-code-row">
        <input inputMode="numeric" autoComplete="one-time-code" maxLength={7} placeholder="123456" value={code} autoFocus
          onChange={e => setCode(e.target.value)} aria-label="Code from your authenticator app" />
        <button className="btn primary" disabled={busy}>{busy ? 'Checking…' : 'Verify'}</button>
        {onSkip && <button type="button" className="btn" onClick={onSkip}>Not now</button>}
      </div>
      {error && <div className="error">{error}</div>}
    </form>
  );
}

export default function AccountSecurityPage() {
  const { isAdmin, isPlatformOwner } = useAuth();
  const mfa = useMfa();
  const [enrolling, setEnrolling] = useState<{ id: string; qr: string; secret: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function start() {
    setError(null); setMessage(null);
    // A half-finished setup from before is removed first, so the new QR code is the only one.
    const { data: list } = await supabase.auth.mfa.listFactors();
    for (const f of (list?.all ?? []).filter(f => f.status === 'unverified')) await supabase.auth.mfa.unenroll({ factorId: f.id });
    const { data, error: e } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: `Donor Base ${new Date().toISOString().slice(0, 10)}` });
    if (e || !data) return setError(e?.message ?? 'Couldn’t start the setup.');
    setEnrolling({ id: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
  }

  async function remove() {
    if (!mfa.factorId || !confirm('Turn off two-step verification? You won’t be able to see bank and reconciliation data until you set it up again.')) return;
    const { error: e } = await supabase.auth.mfa.unenroll({ factorId: mfa.factorId });
    if (e) return setError(e.message);
    await supabase.auth.refreshSession();
    setMessage('Two-step verification is off.');
    void mfa.reload();
  }

  return (
    <section className="view narrow">
      <div className="view-head"><div className="view-title"><h1>Account security</h1><span className="count">Two-step verification</span></div></div>
      {message && <div className="notice">{message}</div>}
      {error && <div className="error">{error}</div>}
      <div className="panel-box">
        <h2><ShieldCheck size={16} /> Two-step verification {mfa.enrolled ? <Pill tone="green">On</Pill> : <Pill>Off</Pill>}
          {mfa.verified && <Pill tone="blue">This session verified</Pill>}</h2>
        <p className="muted small">After your password, you also enter a 6-digit code from an authenticator app on your phone
          (Google Authenticator, Microsoft Authenticator, 1Password and similar).
          {(isAdmin || isPlatformOwner) && ' It is required to see bank and reconciliation data.'}</p>

        {!mfa.loading && !mfa.enrolled && !enrolling && <button type="button" className="btn primary" onClick={start}>Set up two-step verification</button>}

        {enrolling && (
          <div className="mfa-enroll">
            <ol className="small">
              <li>Open your authenticator app and add an account by scanning this code.</li>
              <li>Or type this key: <code className="mfa-secret">{enrolling.secret}</code></li>
              <li>Enter the 6-digit code the app shows.</li>
            </ol>
            <img className="mfa-qr" src={enrolling.qr} alt="QR code for your authenticator app" width={180} height={180} />
            <CodePrompt factorId={enrolling.id} intro="Enter the code to finish."
              onDone={() => { setEnrolling(null); setMessage('Two-step verification is on, and this session is verified.'); void mfa.reload(); }} />
          </div>
        )}

        {mfa.enrolled && !mfa.verified && mfa.factorId && (
          <CodePrompt factorId={mfa.factorId} intro="This session hasn’t been verified yet. Enter a code to see bank data." onDone={() => void mfa.reload()} />
        )}
        {mfa.enrolled && <div className="form-actions"><div className="spacer" /><button type="button" className="btn danger" onClick={remove}>Turn off</button></div>}
      </div>
    </section>
  );
}
