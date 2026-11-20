import PageTabs, { usePageTab } from '../components/PageTabs';
import { PRODUCT_MARK } from '../components/Layout';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Mail, MessageSquare, Send, X } from 'lucide-react';
import DataTable, { type Column } from '../components/DataTable';
import { Pill } from '../components/Pill';
import { useAuth } from '../lib/auth';
import { dateTime } from '../lib/format';
import { fetchAll, supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';
import { Overlay } from './Pledges';
import { KeysPanel, NO_KEYS, ownKeys, ownWebhook, useKeyStatus, type KeyStatus } from './IntegrationKeys';

// Every email and text the system sends goes through the messages table. Until sending is switched on,
// only the test list gets anything; the rest is held and shows here.

const STATUS: Record<string, { label: string; tone: 'green' | 'red' | 'amber' | 'blue' | '' }> = {
  queued: { label: 'Queued', tone: 'blue' },
  sending: { label: 'Sending', tone: 'blue' },
  sent: { label: 'Sent', tone: '' },
  delivered: { label: 'Delivered', tone: 'green' },
  failed: { label: 'Failed', tone: 'red' },
  opted_out: { label: 'Opted out', tone: 'amber' },
  held: { label: 'Held (test mode)', tone: 'amber' },
};
export const MessagePill = ({ status }: { status: string }) => <Pill tone={STATUS[status]?.tone ?? ''}>{STATUS[status]?.label ?? status}</Pill>;
const channelLabel = (c: string) => (c === 'sms' ? 'Text' : 'Email');
const kindLabel = (k: string) => k.charAt(0).toUpperCase() + k.slice(1).replace(/_/g, ' ');

/** The portal's own address, for links in texts. */
const portalBase = () => window.location.origin + import.meta.env.BASE_URL;

// ---------------------------------------------------------------------------
// Sending a receipt or statement
// ---------------------------------------------------------------------------
export function SendDocumentDialog({ kind, recordId, donorId, campaignId, title, build, onClose, to, onSent }: {
  kind: 'receipt' | 'statement'; recordId: string; donorId: string | null; campaignId?: string | null; title: string;
  build: () => Promise<string>; onClose: () => void;
  /** Where the donor asked for it to go, in place of the addresses on their record. */
  to?: { email?: string | null; phone?: string | null }; onSent?: () => void;
}) {
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [useEmail, setUseEmail] = useState(true);
  const [useText, setUseText] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<Row[] | null>(null);
  useEffect(() => {
    // A donor's own request goes everywhere they asked; otherwise email first, text only without an email.
    const fill = (e: string | null | undefined, p: string | null | undefined, both: boolean) => {
      setEmail(e ?? '');
      setPhone(p ?? '');
      setUseEmail(!!e || !p);
      setUseText(!!p && (both || !e));
    };
    if (to) return fill(to.email, to.phone, true);
    if (!donorId) return;
    supabase.from('donors').select('email, phone').eq('id', donorId).maybeSingle().then(({ data }) => fill(data?.email, data?.phone, false));
  }, [donorId, to]);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const html = await build();
      const { data, error: e } = await supabase.rpc('send_document', {
        p_kind: kind, p_record_id: recordId, p_donor: donorId, p_title: title, p_html: html,
        p_email: useEmail ? email : null, p_phone: useText ? phone : null, p_link_base: portalBase(), p_campaign: campaignId ?? null,
      });
      if (e) throw new Error(e.message);
      const ids = Object.values((data ?? {}) as Record<string, string>);
      setSent(((await supabase.from('messages').select('id, channel, to_address, status, error').in('id', ids)).data ?? []) as Row[]);
      onSent?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Overlay onClose={onClose}>
      <div className="form-head"><h2>Send {kind === 'receipt' ? 'receipt' : 'statement'} {title}</h2><button type="button" className="icon-btn" title="Close" onClick={onClose}><X size={18} /></button></div>
      {sent ? (
        <>
          {sent.map(m => (
            <p key={m.id}>{channelLabel(m.channel)} to <b>{m.to_address}</b>: <MessagePill status={m.status} />
              {m.status !== 'queued' && m.error && <span className="muted small"> {m.error}</span>}</p>
          ))}
          <p className="muted small">Delivery shows in <Link to="/messages">Sent Messages</Link>. A failure lands on the Task Sheet.</p>
          <div className="form-actions"><div className="spacer" /><button type="button" className="btn primary" onClick={onClose}>Done</button></div>
        </>
      ) : (
        <>
          <div className="fields">
            <label className="inline-check"><input type="checkbox" checked={useEmail} onChange={e => setUseEmail(e.target.checked)} /> <Mail size={15} /> Email</label>
            <label className="field"><span>Email address</span><input type="email" value={email} disabled={!useEmail} onChange={e => setEmail(e.target.value)} /></label>
            <label className="inline-check"><input type="checkbox" checked={useText} onChange={e => setUseText(e.target.checked)} /> <MessageSquare size={15} /> Text</label>
            <label className="field"><span>Phone</span><input type="tel" value={phone} disabled={!useText} onChange={e => setPhone(e.target.value)} /></label>
          </div>
          <p className="muted small">The email carries the {kind} itself. The text carries a private link that opens it, good for a year.
            Changing an address here doesn't change the donor's record.</p>
          {error && <div className="error">{error}</div>}
          <div className="form-actions"><div className="spacer" /><button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="button" className="btn primary" disabled={busy || (!useEmail && !useText) || (useEmail && !email.trim()) || (useText && !phone.trim())} onClick={send}>
              <Send size={15} /> Send</button></div>
        </>
      )}
    </Overlay>
  );
}

// ---------------------------------------------------------------------------
// Sent Messages
// ---------------------------------------------------------------------------
export function MessagesPage() {
  const [version, setVersion] = useState(0);
  const [open, setOpen] = useState<Row | null>(null);
  const q = useQuery(
    () => fetchAll((a, b) => supabase.from('messages').select('*').order('created_at', { ascending: false }).range(a, b) as never),
    [version],
  );
  const columns: Column[] = [
    { key: 'created_at', label: 'Created', render: r => dateTime(r.created_at), value: r => r.created_at },
    { key: 'status', label: 'Status', render: r => <MessagePill status={r.status} />, value: r => STATUS[r.status]?.label ?? r.status },
    { key: 'channel', label: 'By', value: r => channelLabel(r.channel) },
    { key: 'kind', label: 'What', value: r => kindLabel(r.kind) },
    { key: 'to_name', label: 'To', width: 160 },
    { key: 'to_address', label: 'Address', width: 200 },
    { key: 'subject', label: 'Subject or text', long: true, width: 260, value: r => r.subject ?? r.body },
    { key: 'error', label: 'Problem', long: true, width: 220 },
    { key: 'created_by', label: 'Sent by', optional: true },
  ];
  return (
    <section className="view">
      <DataTable
        title="Sent Messages"
        subtitle="Every email and text the system sends, with what the provider reported back."
        rows={(q.data as Row[]) ?? []}
        loading={q.loading}
        error={q.error}
        columns={columns}
        exportName="messages"
        onOpen={setOpen}
      />
      {open && <MessageDialog message={open} onClose={() => setOpen(null)} onChanged={() => { setOpen(null); setVersion(v => v + 1); }} />}
    </section>
  );
}

function MessageDialog({ message: m, onClose, onChanged }: { message: Row; onClose: () => void; onChanged: () => void }) {
  return (
    <Overlay onClose={onClose}>
      <div className="form-head"><h2>{channelLabel(m.channel)} to {m.to_name ?? m.to_address} <MessagePill status={m.status} /></h2>
        <button type="button" className="icon-btn" title="Close" onClick={onClose}><X size={18} /></button></div>
      <dl className="record-facts">
        <dt>To</dt><dd>{m.to_address}</dd>
        <dt>What</dt><dd>{kindLabel(m.kind)}{m.donor_id && <> · <Link to={`/donors/${encodeURIComponent(m.donor_id)}`}>donor</Link></>}</dd>
        <dt>Created</dt><dd>{dateTime(m.created_at)}{m.created_by && ` by ${m.created_by}`}</dd>
        {m.sent_at && <><dt>Sent</dt><dd>{dateTime(m.sent_at)}</dd></>}
        {m.delivered_at && <><dt>Delivered</dt><dd>{dateTime(m.delivered_at)}</dd></>}
        {m.opened_at && <><dt>Opened</dt><dd>{dateTime(m.opened_at)}</dd></>}
        {m.clicked_at && <><dt>Clicked</dt><dd>{dateTime(m.clicked_at)}</dd></>}
        {m.error && <><dt>Problem</dt><dd>{m.error}</dd></>}
        {m.subject && <><dt>Subject</dt><dd>{m.subject}</dd></>}
      </dl>
      {m.html
        ? <iframe className="message-preview" title="Email" sandbox="" srcDoc={m.html} />
        : <pre className="message-text">{m.body}</pre>}
      {['failed', 'held', 'opted_out'].includes(m.status) && !m.resent_as && <ResendMessage messageId={m.id} address={m.to_address} channel={m.channel} onDone={onChanged} />}
      {m.resent_as && <p className="muted small">Sent again as a new message.</p>}
    </Overlay>
  );
}

/** Sends a failed or held message again, to the same address or a corrected one. */
export function ResendMessage({ messageId, address, channel, onDone }: { messageId: string; address: string; channel: string; onDone: () => void }) {
  const [to, setTo] = useState(address);
  const [error, setError] = useState<string | null>(null);
  async function resend() {
    setError(null);
    const { error: e } = await supabase.rpc('resend_message', { p_id: messageId, p_to: to });
    if (e) return setError(e.message);
    window.dispatchEvent(new Event('task-sheet-changed'));
    onDone();
  }
  return (
    <div className="panel-box">
      <label className="field"><span>Send again to</span><input type={channel === 'sms' ? 'tel' : 'email'} value={to} onChange={e => setTo(e.target.value)} /></label>
      <p className="muted small">Check the {channel === 'sms' ? 'number' : 'address'} first, and fix it on the donor or fundraiser record too if it was wrong.</p>
      {error && <div className="error">{error}</div>}
      <div className="form-actions"><div className="spacer" /><button type="button" className="btn primary" disabled={!to.trim()} onClick={resend}><Send size={15} /> Send again</button></div>
    </div>
  );
}

/** On the Task Sheet: the failed message and a way to send it again. */
export function DeliveryFailed({ messageId, onDone }: { messageId: string; onDone: () => void }) {
  const q = useQuery(async () => (await supabase.from('messages').select('*').eq('id', messageId).maybeSingle()).data as Row | null, [messageId]);
  const m = q.data as Row | null;
  if (!m) return null;
  return (
    <>
      {m.html
        ? <iframe className="message-preview" title="Email" sandbox="" srcDoc={m.html} />
        : <pre className="message-text">{m.body}</pre>}
      <ResendMessage messageId={m.id} address={m.to_address} channel={m.channel} onDone={onDone} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Messaging Settings
// ---------------------------------------------------------------------------
const MSG_TABS = [['sending', 'Sending'], ['accounts', 'Your accounts'], ['platform', 'Platform accounts'], ['opt-outs', 'Opt-outs']] as const;

export function MessagingSettingsPage() {
  const [tab, setTab] = usePageTab(MSG_TABS.map(([k]) => k));
  const { org, isPlatformOwner } = useAuth();
  const keyQ = useKeyStatus();
  const [version, setVersion] = useState(0);
  const q = useQuery(async () => {
    const [s, p, o] = await Promise.all([
      supabase.from('messaging_settings').select('*').maybeSingle(),
      supabase.from('messaging_providers').select('*').maybeSingle(),
      supabase.from('message_opt_outs').select('*').order('created_at', { ascending: false }),
    ]);
    return { settings: s.data as Row | null, providers: p.data as Row | null, optOuts: (o.data ?? []) as Row[] };
  }, [version]);
  const [form, setForm] = useState({ from_name: '', from_email: '', reply_to: '', sms_from: '', live: false, tests: '' });
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testTo, setTestTo] = useState('');
  const [testChannel, setTestChannel] = useState<'email' | 'sms'>('email');
  const [testResult, setTestResult] = useState<string | null>(null);

  const data = q.data as { settings: Row | null; providers: Row | null; optOuts: Row[] } | undefined;
  useEffect(() => {
    const s = data?.settings;
    setForm({
      from_name: s?.from_name ?? '', from_email: s?.from_email ?? '', reply_to: s?.reply_to ?? '', sms_from: s?.sms_from ?? '',
      live: !!s?.live, tests: ((s?.test_recipients ?? []) as string[]).join('\n'),
    });
  }, [data?.settings]);

  async function save(live = form.live) {
    setError(null);
    setSaved(false);
    if (live && !form.live && !confirm('Switch sending on? Receipts, notifications and outreach will reach real donors and fundraisers from now on.')) return;
    const { error: e } = await supabase.rpc('save_messaging_settings', {
      p_from_name: form.from_name, p_from_email: form.from_email, p_reply_to: form.reply_to, p_sms_from: form.sms_from,
      p_live: live, p_test_recipients: form.tests.split(/[\n,]/).map(t => t.trim()).filter(Boolean),
    });
    if (e) return setError(e.message);
    setSaved(true);
    setVersion(v => v + 1);
  }
  async function sendTest() {
    setTestResult(null);
    const { data: id, error: e } = await supabase.rpc('send_test_message', { p_channel: testChannel, p_to: testTo });
    if (e) return setTestResult(e.message);
    // Give the sender a few seconds, then show where it got to.
    setTestResult('Sending…');
    setTimeout(async () => {
      const { data: m } = await supabase.from('messages').select('status, error').eq('id', id).maybeSingle();
      setTestResult(m ? `${STATUS[m.status]?.label ?? m.status}${m.error ? `: ${m.error}` : ''}` : 'Queued');
    }, 6000);
  }
  async function removeOptOut(o: Row) {
    if (!confirm(`Let ${o.address} get texts again? Only do this if they asked.`)) return;
    const { error: e } = await supabase.rpc('remove_opt_out', { p_channel: o.channel, p_address: o.address });
    if (e) return setError(e.message);
    setVersion(v => v + 1);
  }

  const p = data?.providers;
  const keys = (keyQ.data as KeyStatus | undefined) ?? NO_KEYS;
  const fn = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/message-events`;
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm(f => ({ ...f, [k]: e.target.value }));
  return (
    <section className="view">
      <div className="view-head">
        <div className="view-title"><h1>Messaging Settings</h1><span className="count">Email and text sending</span></div>
      </div>
      <PageTabs tabs={MSG_TABS.filter(([k]) => k !== 'platform' || isPlatformOwner)} value={tab} onChange={setTab} />

      {tab === 'sending' && <>

      <div className="panel-box">
        <h2>{form.live ? <Pill tone="green">Sending is on</Pill> : <Pill tone="amber">Test mode</Pill>}</h2>
        <p className="muted small">{form.live
          ? 'Emails and texts go to everyone they are addressed to.'
          : 'Only the addresses on the test list get anything. Everything else is held and shows in Sent Messages, so you can see what would have gone out.'}</p>
        <div className="form-actions">
          {form.live
            ? <button type="button" className="btn" onClick={() => save(false)}>Back to test mode</button>
            : <button type="button" className="btn primary" onClick={() => save(true)}>Switch sending on</button>}
        </div>
      </div>

      <div className="panel-box">
        <h2>Sender</h2>
        <div className="fields">
          <label className="field"><span>From name</span><input value={form.from_name} placeholder={org?.name} onChange={set('from_name')} /></label>
          <label className="field"><span>From email</span><input type="email" value={form.from_email} placeholder="notifications@mail.trubase.org" onChange={set('from_email')} />
            <small className="muted">Must be on a domain verified in SendGrid. Leave empty for the default.</small></label>
          <label className="field"><span>Replies go to</span><input type="email" value={form.reply_to} placeholder={org?.email ?? ''} onChange={set('reply_to')} /></label>
          <label className="field"><span>Texting number</span><input type="tel" value={form.sms_from} placeholder="+1 845 613 4272" onChange={set('sms_from')} />
            <small className="muted">The Twilio number texts come from.</small></label>
          <label className="field wide"><span>Test list</span><textarea rows={3} value={form.tests} onChange={set('tests')} placeholder="One email address or phone number per line" />
            <small className="muted">In test mode, only these get messages.</small></label>
        </div>
        {saved && <div className="notice">Saved.</div>}
        {error && <div className="error">{error}</div>}
        <div className="form-actions"><div className="spacer" /><button type="button" className="btn primary" onClick={() => save()}>Save sender</button></div>
      </div>

      <div className="panel-box">
        <h2>Send a test</h2>
        <div className="fields">
          <label className="field"><span>By</span>
            <select value={testChannel} onChange={e => setTestChannel(e.target.value as 'email' | 'sms')}><option value="email">Email</option><option value="sms">Text</option></select></label>
          <label className="field"><span>To</span><input value={testTo} onChange={e => setTestTo(e.target.value)} placeholder={testChannel === 'sms' ? 'Phone number' : 'Email address'} /></label>
        </div>
        {testResult && <p>{testResult}</p>}
        <div className="form-actions"><div className="spacer" /><button type="button" className="btn" disabled={!testTo.trim()} onClick={sendTest}><Send size={15} /> Send test</button></div>
      </div>

      </>}

      {tab === 'accounts' && <>
      <p className="muted small">Your organization's own SendGrid and Twilio accounts. Until you add them, the platform's accounts send for you.</p>
      <KeysPanel service="sendgrid" status={keys} onSaved={() => void keyQ.reload()}
        platformNote={`Email goes out through the platform's SendGrid account${p?.checked_at ? (p.email_ready ? '.' : ', but its key is missing.') : '.'} The From email must be on a domain that account has verified.`}
        intro={<>In SendGrid: Settings → API Keys → Create API Key, with Mail Send access. For delivery reports: Settings → Mail Settings → Event Webhook,
          paste the address below, turn signing on, and copy the verification key here.</>}
        fields={[
          { name: 'api', label: 'API key', secret: true, set: keys.sendgrid_key_set, placeholder: 'SG.…', help: 'Stored encrypted; only the sender can read it.' },
          { name: 'hook', label: 'Event Webhook verification key', secret: false, set: keys.sendgrid_webhook_key_set, placeholder: 'MFkwEwYHKoZIzj0…' },
        ]}>
        {ownKeys(keys, 'sendgrid') && <dl className="record-facts"><dt>Event Webhook address</dt><dd><code>{ownWebhook('sendgrid', org?.id)}</code></dd></dl>}
        {!keys.sendgrid_webhook_key_set && ownKeys(keys, 'sendgrid') && <p className="muted small">Without the verification key, delivery reports from your SendGrid account aren't accepted.</p>}
      </KeysPanel>

      <KeysPanel service="twilio" status={keys} onSaved={() => void keyQ.reload()}
        platformNote={`Texts go out through the platform's Twilio account${p?.checked_at ? (p.sms_ready ? '.' : ', but its keys are missing.') : '.'} The texting number must belong to that account.`}
        intro={<>In the Twilio Console: Account Info shows the Account SID and Auth Token. The texting number above must be in this account.</>}
        fields={[
          { name: 'sid', label: 'Account SID', secret: false, set: !!keys.twilio_sid, shown: keys.twilio_sid, placeholder: 'AC…' },
          { name: 'token', label: 'Auth Token', secret: true, set: keys.twilio_token_set, placeholder: '32 letters and numbers', help: 'Stored encrypted; only the sender can read it.' },
        ]}>
        {ownKeys(keys, 'twilio') && (
          <>
            <dl className="record-facts"><dt>"A message comes in" webhook</dt><dd><code>{ownWebhook('twilio', org?.id)}</code></dd></dl>
            <p className="muted small">In Twilio: Phone Numbers → your number → Messaging → "A message comes in", as HTTP POST. Delivery reports find their way back on their own.</p>
          </>
        )}
      </KeysPanel>

      </>}

      {tab === 'platform' && isPlatformOwner && (
        <div className="panel-box">
          <h2>Platform accounts</h2>
          <p className="muted small">For organizations without their own keys. In the platform's SendGrid: Event Webhook. In its Twilio: each number's "A message comes in" webhook.</p>
          <dl className="record-facts">
            <dt>SendGrid events</dt><dd><code>{fn}?provider=sendgrid</code></dd>
            <dt>Twilio incoming texts</dt><dd><code>{fn}?provider=twilio</code></dd>
            {p?.checked_at && <><dt>Last checked</dt><dd>{dateTime(p.checked_at)}</dd></>}
          </dl>
        </div>
      )}

      {tab === 'opt-outs' && <div className="panel-box">
        <h2>Opted out of texts</h2>
        {data?.optOuts.length ? (
          <table className="grid"><thead><tr><th>Number</th><th>Since</th><th>How</th><th /></tr></thead>
            <tbody>{data.optOuts.map(o => (
              <tr key={o.channel + o.address}><td>{o.address}</td><td>{dateTime(o.created_at)}</td><td>{o.source === 'reply' ? 'Replied STOP' : 'Reported by Twilio'}</td>
                <td><button type="button" className="link" onClick={() => removeOptOut(o)}>Allow texts again</button></td></tr>
            ))}</tbody></table>
        ) : <p className="muted small">Nobody has replied STOP.</p>}
      </div>}
    </section>
  );
}

// ---------------------------------------------------------------------------
// A shared page, opened from a link in a text. No sign-in.
// ---------------------------------------------------------------------------
export function SharedDocumentPage({ token }: { token: string }) {
  const [doc, setDoc] = useState<{ title: string; html: string } | null | undefined>(undefined);
  useEffect(() => {
    supabase.rpc('shared_document', { p_token: token }).then(({ data }) => setDoc(((data ?? []) as { title: string; html: string }[])[0] ?? null));
  }, [token]);
  useEffect(() => { if (doc) document.title = doc.title; }, [doc]);
  if (doc === undefined) return <div className="splash"><img className="splash-mark" src={PRODUCT_MARK} alt="Donor Base" /></div>;
  if (!doc) return <div className="shared-missing"><h1>This link has expired</h1><p>Ask the office to send it again.</p></div>;
  return (
    <div className="shared-doc">
      <div className="shared-bar"><button type="button" className="btn" onClick={() => (document.querySelector('.shared-doc iframe') as HTMLIFrameElement)?.contentWindow?.print()}>Print or save as PDF</button></div>
      <iframe title={doc.title} srcDoc={doc.html} sandbox="allow-modals allow-same-origin" />
    </div>
  );
}
