import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Copy, Inbox as InboxIcon, Paperclip } from 'lucide-react';
import CrudPage from '../components/CrudPage';
import DataTable, { type Column } from '../components/DataTable';
import PageTabs, { usePageTab } from '../components/PageTabs';
import { Pill } from '../components/Pill';
import type { Field } from '../components/RecordForm';
import { useAuth } from '../lib/auth';
import { dateTime } from '../lib/format';
import { fetchAll, supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';
import { Overlay } from './Pledges';

/*
 * The organization's email inbox (Shulim, 2026-11-19; docs/review/org-inbox-plan-2026-11-19.md). Mail sent or
 * forwarded to the organization's random address is stored here with its attachments. A trusted sender whose mail
 * proves it's really theirs (DKIM or SPF aligned with the From address) goes to review; anything else is kept as not
 * trusted. Nothing posts by itself: a person reads each one and marks it reviewed.
 */

export const REPORT_TYPES: [string, string][] = [
  ['ojc_ach', 'OJC ACH deposit'], ['ojc_submission', 'OJC certificate submission'], ['pledger_ach', 'Pledger ACH notification'],
  ['pledger_batch', 'Pledger batch confirmation'], ['bank_check_deposit', 'Bank check deposit'], ['ab_charity', 'AB Charity payout'],
  ['zelle', 'Zelle notice'], ['wire', 'Wire notice'], ['sola_settlement', 'Sola settlement'], ['other', 'Other'],
];
const reportLabel = (k?: string | null) => REPORT_TYPES.find(([v]) => v === k)?.[1] ?? '—';

export const STATUS: Record<string, [string, 'green' | 'amber' | 'red' | 'blue' | '']> = {
  to_review: ['To review', 'blue'], possible_duplicate: ['Possible duplicate', 'amber'], not_trusted: ['Not trusted', 'red'],
  reviewed: ['Reviewed', 'green'], ignored: ['Ignored', ''], new: ['New', ''],
};
const StatusPill = ({ s }: { s: string }) => <Pill tone={STATUS[s]?.[1] ?? ''}>{STATUS[s]?.[0] ?? s}</Pill>;

const senderFields: Field[] = [
  { name: 'pattern', label: 'Sender', required: true, help: 'An exact address (notifications@ojcfund.org) or a whole domain starting with @ (@ojcfund.org)',
    validate: v => (/^(@[a-z0-9.-]+\.[a-z]{2,}|[^@\s]+@[a-z0-9.-]+\.[a-z]{2,})$/i.test(String(v ?? '').trim()) ? null : 'Enter an email address, or @ and a domain') },
  { name: 'report_type', label: 'What it sends', type: 'select', required: true, options: REPORT_TYPES.map(([value, label]) => ({ value, label })) },
  { name: 'label', label: 'Note' },
];

const TABS = [['emails', 'Emails'], ['address', 'Address & settings'], ['senders', 'Trusted senders']] as const;

export default function EmailInboxPage() {
  const { permissions } = useAuth();
  const [tab, setTab] = usePageTab(TABS.map(([k]) => k));
  if (!permissions.includes('manage_inbox')) {
    return <section className="view"><p className="muted">The email inbox is for admins with the Inbox permission (Users &amp; Access → Permissions).</p></section>;
  }
  return (
    <section className="view">
      <PageTabs tabs={TABS} value={tab} onChange={setTab} />
      {tab === 'emails' && <Emails />}
      {tab === 'address' && <AddressCard />}
      {tab === 'senders' && (
        <CrudPage title="Trusted Senders" noun="Sender" table="inbox_trusted_senders" order={{ column: 'pattern' }} canEdit defaults={{ report_type: 'other' }}
          extraActions={<span className="muted small">Mail from these senders goes to review, once it proves it's really from them. Everyone else's is kept as not trusted.</span>}
          columns={[
            { key: 'pattern', label: 'Sender', width: 260 },
            { key: 'report_type', label: 'What it sends', value: r => reportLabel(r.report_type) },
            { key: 'label', label: 'Note' },
          ]}
          fields={senderFields} />
      )}
    </section>
  );
}

function AddressCard() {
  const q = useQuery(async () => {
    const { data, error } = await supabase.rpc('inbox_status');
    if (error) throw new Error(error.message);
    return ((data ?? []) as Row[])[0] ?? null;
  }, []);
  const s = q.data as Row | null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [keep, setKeep] = useState<number | null>(null);
  const [cap, setCap] = useState<number | null>(null);
  const settings = useQuery(async () => ((await supabase.from('inbox_settings').select('*').maybeSingle()).data as Row | null), []);
  useEffect(() => {
    if (settings.data !== undefined) { setKeep(Number(settings.data?.keep_years ?? 7)); setCap(Number(settings.data?.daily_cap ?? 500)); }
  }, [settings.data]);

  async function act(fn: 'inbox_new_address' | 'inbox_turn_off', question: string) {
    if (!confirm(question)) return;
    setBusy(true); setError(null);
    const { error: e } = await supabase.rpc(fn);
    setBusy(false);
    if (e) return setError(e.message);
    void q.reload();
  }
  async function saveSettings() {
    setError(null);
    const { error: e } = await supabase.from('inbox_settings').upsert({ keep_years: keep, daily_cap: cap }, { onConflict: 'org_id' });
    if (e) return setError(e.message);
    void settings.reload();
  }
  if (q.loading) return <p className="muted">Loading…</p>;
  if (q.error) return <div className="error">{q.error}</div>;
  const address = s?.address as string | null;
  return (
    <div className="card inbox-card">
      <h3><InboxIcon size={20} /> Inbox address</h3>
      {!s?.domain_set && <div className="notice">The inbox isn't switched on for the platform yet. Ask the Platform Owner.</div>}
      {address ? (
        <>
          <div className="inbox-address">
            <code>{address}</code>
            <button type="button" className="btn" onClick={() => { void navigator.clipboard?.writeText(address); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
              <Copy size={16} /> {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="muted small">Made {dateTime(s?.created_at)}{s?.created_by ? ` by ${s.created_by}` : ''}. Only this organization's mail comes here.</p>
          {s?.old_address && <p className="muted small">The previous address, {String(s.old_address)}, still works until {dateTime(s.old_until)}.</p>}
          <details className="inbox-help">
            <summary>How to send mail here</summary>
            <ul>
              <li><b>Ask a sender</b> (OJC, Pledger, your bank's alerts…) to send their reports to this address, or add it as a second address in their settings.</li>
              <li><b>Gmail:</b> Settings → Forwarding and POP/IMAP → Add a forwarding address → paste this address. Gmail sends a confirmation code here; it appears under Emails (To review). Copy the code into Gmail, then choose "Forward a copy". To forward only some mail, make a filter (e.g. from:ojcfund.org) and choose "Forward it to" this address.</li>
              <li><b>Outlook:</b> Settings → Mail → Forwarding (or Rules → "Forward to"), and paste this address.</li>
              <li>Then add each sender under <b>Trusted senders</b>, so their mail goes to review.</li>
            </ul>
          </details>
          <div className="donation-actions">
            <button type="button" className="btn" disabled={busy} onClick={() => void act('inbox_new_address', 'Make a new address? The current one keeps working for 14 days, then stops. Update forwarding and senders to the new one.')}>Replace address</button>
            <button type="button" className="btn danger" disabled={busy} onClick={() => void act('inbox_turn_off', 'Turn the inbox off? Mail to this address will be refused from now on. Emails already received stay.')}>Turn off</button>
          </div>
        </>
      ) : (
        <>
          <p>This organization has no inbox address{s?.status === 'none' ? ' yet' : ''}. Make one to receive deposit reports and notices by email.</p>
          <div className="donation-actions">
            <button type="button" className="btn primary" disabled={busy || !s?.domain_set} onClick={() => void act('inbox_new_address', 'Make an inbox address for this organization?')}>Create inbox address</button>
          </div>
        </>
      )}
      <h3>Settings</h3>
      <div className="form-grid">
        <label className="field"><span>Keep raw emails for (years)</span>
          <input type="number" min={1} max={30} value={keep ?? ''} onChange={e => setKeep(Number(e.target.value))} /></label>
        <label className="field"><span>Daily limit (messages)</span>
          <input type="number" min={10} max={10000} value={cap ?? ''} onChange={e => setCap(Number(e.target.value))} /></label>
      </div>
      <p className="muted small">After the years set here, the original email and its attachments are removed; what was read from them stays. Past the daily limit, mail isn't kept that day and the Task Sheet says so.</p>
      <div className="donation-actions"><button type="button" className="btn" onClick={() => void saveSettings()}>Save settings</button></div>
      {error && <div className="error">{error}</div>}
    </div>
  );
}

function Emails() {
  const [params, setParams] = useSearchParams();
  const [show, setShow] = useState<'review' | 'not_trusted' | 'all'>('review');
  const [version, setVersion] = useState(0);
  const q = useQuery(() => fetchAll((a, b) => supabase.from('inbound_emails')
    .select('id, received_at, from_address, from_name, subject, status, authentic, report_type, duplicate_of, spam_score, forwarding_confirmation')
    .eq('complete', true).order('received_at', { ascending: false }).order('id').range(a, b) as never), [version]);
  const all = (q.data as Row[]) ?? [];
  const rows = useMemo(() => all.filter(r => show === 'all' ? true : show === 'review' ? ['to_review', 'possible_duplicate'].includes(r.status) : r.status === 'not_trusted'), [all, show]);
  const openId = params.get('email');
  const columns: Column[] = [
    { key: 'received_at', label: 'Received', render: r => dateTime(r.received_at) },
    { key: 'from_address', label: 'From', width: 220, value: r => (r.from_name ? `${r.from_name} <${r.from_address}>` : r.from_address) },
    { key: 'subject', label: 'Subject', width: 280 },
    { key: 'report_type', label: 'Kind', value: r => (r.forwarding_confirmation ? 'Gmail forwarding code' : reportLabel(r.report_type)) },
    { key: 'status', label: 'Status', render: r => <StatusPill s={r.status} />, value: r => STATUS[r.status]?.[0] ?? r.status },
  ];
  const count = (k: string[]) => all.filter(r => k.includes(r.status)).length;
  return (
    <>
      <DataTable title="Emails" rows={rows} loading={q.loading} error={q.error} columns={columns} exportName="inbox"
        initialSort={{ key: 'received_at', dir: 'desc' }}
        onOpen={r => setParams(p => { p.set('email', String(r.id)); return p; })}
        actions={<select aria-label="Show" value={show} onChange={e => setShow(e.target.value as typeof show)}>
          <option value="review">To review ({count(['to_review', 'possible_duplicate'])})</option>
          <option value="not_trusted">Not trusted ({count(['not_trusted'])})</option>
          <option value="all">All</option>
        </select>} />
      {openId && <EmailView id={openId} onClose={() => setParams(p => { p.delete('email'); return p; })} onChanged={() => setVersion(v => v + 1)} />}
    </>
  );
}

function EmailView({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const [version, setVersion] = useState(0);
  const q = useQuery(async () => {
    const [e, a] = await Promise.all([
      supabase.from('inbound_emails').select('*').eq('id', id).maybeSingle(),
      supabase.from('inbound_attachments').select('*').eq('email_id', id).order('storage_path'),
    ]);
    return { email: e.data as Row | null, files: (a.data ?? []) as Row[] };
  }, [id, version]);
  const [note, setNote] = useState('');
  const [kind, setKind] = useState('other');
  const [error, setError] = useState<string | null>(null);
  const e = q.data?.email;
  async function review(action: 'reviewed' | 'ignored' | 'not_duplicate' | 'reopen') {
    setError(null);
    const { error: err } = await supabase.rpc('inbox_review', { p_email: id, p_action: action, p_note: note || null });
    if (err) return setError(err.message);
    window.dispatchEvent(new Event('task-sheet-changed'));
    setVersion(v => v + 1); onChanged();
  }
  async function trust() {
    setError(null);
    const { error: err } = await supabase.rpc('inbox_trust_sender', { p_email: id, p_report_type: kind });
    if (err) return setError(err.message);
    setVersion(v => v + 1); onChanged();
  }
  async function download(path: string) {
    setError(null);
    const { data, error: err } = await supabase.storage.from('inbox').createSignedUrl(path, 60, { download: true });
    if (err || !data) return setError(err?.message ?? 'Could not open the file');
    window.open(data.signedUrl, '_blank', 'noopener');
  }
  return (
    <Overlay onClose={onClose}>
      {q.loading && !e && <p className="muted">Loading…</p>}
      {!q.loading && !e && <p className="muted">This email isn't here.</p>}
      {e && (
        <>
          <div className="form-head"><h2>{e.subject || '(no subject)'}</h2></div>
          <dl className="record-facts">
            <dt>Status</dt><dd><StatusPill s={e.status} />{e.duplicate_of ? <span className="muted small"> · same message as an earlier one</span> : null}</dd>
            <dt>From</dt><dd>{e.from_name ? `${e.from_name} <${e.from_address}>` : e.from_address}</dd>
            <dt>Received</dt><dd>{dateTime(e.received_at)}{e.sent_at ? <span className="muted small"> · sent {dateTime(e.sent_at)}</span> : null}</dd>
            <dt>Really from them?</dt><dd>{e.authentic ? 'Yes' : 'Not proven'} <span className="muted small">· {e.auth_reason}</span></dd>
            <dt>Kind</dt><dd>{e.forwarding_confirmation ? 'Gmail forwarding confirmation (copy the code into Gmail)' : reportLabel(e.report_type)}</dd>
            {e.spam_score != null && <><dt>Spam score</dt><dd>{String(e.spam_score)}</dd></>}
            {e.reviewed_at && <><dt>Reviewed</dt><dd>{dateTime(e.reviewed_at)} · {e.reviewed_by}{e.review_note ? ` · ${e.review_note}` : ''}</dd></>}
          </dl>
          {e.status === 'not_trusted' && (
            <div className="notice">Not read automatically: the sender isn't on the trusted list{e.authentic ? '' : ', or the message didn\'t prove it\'s really from them'}. Don't open attachments you don't expect.</div>
          )}
          <pre className="inbox-body">{e.body_text || '(no text)'}</pre>
          {(q.data?.files.length ?? 0) > 0 && (
            <ul className="inbox-files">
              {q.data!.files.map(f => (
                <li key={f.id}><Paperclip size={16} /> {f.filename || 'attachment'} <span className="muted small">{f.mime} · {Math.max(1, Math.round(Number(f.size_bytes) / 1024))} KB</span>{' '}
                  <button type="button" className="link" onClick={() => void download(f.storage_path)}>Download</button></li>
              ))}
            </ul>
          )}
          {e.raw_path && <p className="small"><button type="button" className="link" onClick={() => void download(e.raw_path)}>Download the original email (.eml)</button></p>}
          <label className="field"><span>Note (optional)</span><input value={note} onChange={ev => setNote(ev.target.value)} placeholder="e.g. matched to batch 1765557 by hand" /></label>
          {error && <div className="error">{error}</div>}
          <div className="donation-actions">
            {['to_review', 'possible_duplicate', 'not_trusted'].includes(e.status) && <button type="button" className="btn primary" onClick={() => void review('reviewed')}>Mark reviewed</button>}
            {e.status === 'possible_duplicate' && <button type="button" className="btn" onClick={() => void review('not_duplicate')}>Not a duplicate</button>}
            {['to_review', 'possible_duplicate', 'not_trusted'].includes(e.status) && <button type="button" className="btn" onClick={() => void review('ignored')}>Ignore</button>}
            {['reviewed', 'ignored'].includes(e.status) && <button type="button" className="btn" onClick={() => void review('reopen')}>Back to review</button>}
          </div>
          {e.status === 'not_trusted' && e.from_address && (
            <div className="donation-actions">
              <select aria-label="What this sender sends" value={kind} onChange={ev => setKind(ev.target.value)}>
                {REPORT_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
              <button type="button" className="btn" onClick={() => void trust()}>Trust {e.from_address}</button>
            </div>
          )}
          <p className="muted small">Nothing is posted from an email. Record anything it reports in the usual screens, then mark it reviewed.</p>
        </>
      )}
    </Overlay>
  );
}
