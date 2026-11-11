import { useState, type FormEvent } from 'react';
import { ShieldCheck } from 'lucide-react';
import { Pill } from '../components/Pill';
import { useAuth } from '../lib/auth';
import { sendPhoneCode, useMfa, verifyCode, verifyPhoneCode, type MfaState } from '../lib/mfa';
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

/** Get a code by text or call (choice on screen, resend allowed) and enter it. */
export function PhonePrompt({ purpose, phone, defaultChannel, onDone, intro }: {
  purpose: 'enroll' | 'signin'; phone?: string; defaultChannel: 'sms' | 'call'; onDone: () => void; intro?: string;
}) {
  const [channel, setChannel] = useState<'sms' | 'call'>(defaultChannel);
  const [challenge, setChallenge] = useState<{ challengeId: string; masked: string } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  async function send() {
    setBusy(true); setError(null); setNote(null);
    const r = await sendPhoneCode(purpose, channel, phone);
    setBusy(false);
    if ('error' in r) return setError(r.error);
    setChallenge(r); setCode('');
    setNote(channel === 'call' ? `Calling ${r.masked} now. Answer to hear your code.` : `Code sent by text to ${r.masked}.`);
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!challenge) return;
    setBusy(true);
    const problem = await verifyPhoneCode(challenge.challengeId, code);
    setBusy(false);
    if (problem) return setError(problem);
    onDone();
  }
  return (
    <div className="mfa-prompt">
      {intro && <p className="muted">{intro}</p>}
      <div className="mfa-channel" role="radiogroup" aria-label="How to get the code">
        <label><input type="radio" name={`ch-${purpose}`} checked={channel === 'sms'} onChange={() => setChannel('sms')} /> Text me</label>
        <label><input type="radio" name={`ch-${purpose}`} checked={channel === 'call'} onChange={() => setChannel('call')} /> Call me</label>
        <button type="button" className="btn" disabled={busy} onClick={send}>{challenge ? 'Send a new code' : channel === 'call' ? 'Call me with a code' : 'Text me a code'}</button>
      </div>
      {note && <p className="muted small">{note} It expires in 10 minutes.</p>}
      {challenge && (
        <form className="mfa-code-row" onSubmit={submit}>
          <input inputMode="numeric" autoComplete="one-time-code" maxLength={7} placeholder="123456" value={code} autoFocus
            onChange={e => setCode(e.target.value)} aria-label="Code from your text or call" />
          <button className="btn primary" disabled={busy}>{busy ? 'Checking…' : 'Verify'}</button>
        </form>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

/** Verify this session with whatever the person has set up: authenticator app and/or phone. */
export function VerifySession({ mfa, onDone, onSkip, intro }: { mfa: MfaState; onDone: () => void; onSkip?: () => void; intro?: string }) {
  const [method, setMethod] = useState<'totp' | 'phone'>(mfa.factorId ? 'totp' : 'phone');
  return (
    <div className="mfa-prompt">
      {intro && <p className="muted">{intro}</p>}
      {mfa.factorId && mfa.phone && (
        <div className="mfa-channel">
          <button type="button" className={`chip-btn ${method === 'totp' ? 'active' : ''}`} onClick={() => setMethod('totp')}>Authenticator app</button>
          <button type="button" className={`chip-btn ${method === 'phone' ? 'active' : ''}`} onClick={() => setMethod('phone')}>Text or call {mfa.phone.masked}</button>
        </div>
      )}
      {method === 'totp' && mfa.factorId && <CodePrompt factorId={mfa.factorId} onDone={onDone} onSkip={onSkip} />}
      {method === 'phone' && mfa.phone && <PhonePrompt purpose="signin" defaultChannel={mfa.phone.channel} onDone={onDone} />}
      {method === 'phone' && onSkip && <button type="button" className="btn" onClick={onSkip}>Not now</button>}
    </div>
  );
}

/** Add, change or remove the phone for text or call codes. */
function PhoneSection({ mfa, onChanged }: { mfa: MfaState & { reload: () => Promise<void> }; onChanged: (msg: string) => void }) {
  const [adding, setAdding] = useState(false);
  const [phone, setPhone] = useState('');
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function setChannel(ch: 'sms' | 'call') {
    const { error: e } = await supabase.rpc('mfa_phone_set_channel', { p_channel: ch });
    if (e) return setError(e.message);
    void mfa.reload();
  }
  async function remove() {
    if (!confirm('Remove this phone? Text and call codes will stop.')) return;
    const { error: e } = await supabase.rpc('mfa_phone_remove');
    if (e) return setError(e.message);
    onChanged('The phone was removed.');
    void mfa.reload();
  }
  return (
    <div className="panel-box">
      <h2>Text or call codes {mfa.phone ? <Pill tone="green">On</Pill> : <Pill>Off</Pill>}</h2>
      <p className="muted small">No app needed: get a 6-digit code by text message or a phone call when you sign in.</p>
      {mfa.phone && !adding && (
        <>
          <p>Codes go to <b>{mfa.phone.masked}</b> by default by{' '}
            <select value={mfa.phone.channel} onChange={e => setChannel(e.target.value as 'sms' | 'call')} aria-label="Default way to get codes">
              <option value="sms">text</option><option value="call">phone call</option>
            </select>. You can choose the other each time.</p>
          <div className="form-actions">
            <button type="button" className="btn" onClick={() => { setAdding(true); setReady(false); setPhone(''); }}>Change phone</button>
            <div className="spacer" /><button type="button" className="btn danger" onClick={remove}>Remove phone</button>
          </div>
        </>
      )}
      {!mfa.phone && !adding && <button type="button" className="btn primary" onClick={() => { setAdding(true); setReady(false); }}>Add a phone</button>}
      {adding && (
        <div className="mfa-enroll">
          <label className="field"><span>Phone number (US)</span>
            <input type="tel" autoComplete="tel" value={phone} placeholder="(845) 555-0123" onChange={e => { setPhone(e.target.value); setReady(false); }} /></label>
          {!ready && <div className="form-actions"><button type="button" className="btn" onClick={() => setAdding(false)}>Cancel</button><div className="spacer" />
            <button type="button" className="btn primary" disabled={phone.replace(/\D/g, '').length < 10} onClick={() => setReady(true)}>Next</button></div>}
          {ready && <PhonePrompt purpose="enroll" phone={phone} defaultChannel="sms" intro="Choose how to get a code, then enter it to confirm this phone."
            onDone={() => { setAdding(false); onChanged('The phone is set up, and this session is verified.'); void mfa.reload(); }} />}
        </div>
      )}
      {error && <div className="error">{error}</div>}
    </div>
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
        <h2><ShieldCheck size={16} /> Authenticator app {mfa.factorId ? <Pill tone="green">On</Pill> : <Pill>Off</Pill>}
          {mfa.verified && <Pill tone="blue">This session verified</Pill>}</h2>
        <p className="muted small">After your password, you also enter a 6-digit code from an authenticator app on your phone
          (Google Authenticator, Microsoft Authenticator, 1Password and similar).
          {(isAdmin || isPlatformOwner) && ' It is required to see bank and reconciliation data.'}</p>

        {!mfa.loading && !mfa.factorId && !enrolling && <button type="button" className="btn primary" onClick={start}>Set up two-step verification</button>}

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

        {mfa.factorId && <div className="form-actions"><div className="spacer" /><button type="button" className="btn danger" onClick={remove}>Turn off</button></div>}
      </div>
      <PhoneSection mfa={mfa} onChanged={setMessage} />
      {mfa.enrolled && !mfa.verified && (
        <div className="panel-box">
          <h2>Verify this session</h2>
          <VerifySession mfa={mfa} intro="This session hasn’t been verified yet. Verify it to see bank and reconciliation data, or to change your second step." onDone={() => void mfa.reload()} />
        </div>
      )}
    </section>
  );
}
