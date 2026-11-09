import { useEffect, useMemo, useState } from 'react';
import { Copy, Mail, MessageSquare, Paperclip, Send, Trash2, X } from 'lucide-react';
import DataTable, { type Column } from '../components/DataTable';
import SearchSelect from '../components/SearchSelect';
import { Pill } from '../components/Pill';
import { dateTime } from '../lib/format';
import { campaignOptions, donorOptions, managerOptions, type Option } from '../lib/lookups';
import { fetchAll, supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';
import { MessagePill } from './Messaging';
import { Overlay } from './Pledges';

// Sharing a campaign's payment link, and Custom Outreach. Both are marketing sends: emails carry an
// unsubscribe link and texts say how to opt out, which the database adds.

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
/** The same formatting the server applies: **bold**, *italic*, links and line breaks. */
const formatHtml = (s: string) => esc(s)
  .replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, '<a href="$1">$1</a>')
  .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
  .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
  .replace(/\n/g, '<br>');
const personalize = (s: string, r: Recipient) => s
  .replace(/\{first_name\}/g, r.first_name ?? '').replace(/\{last_name\}/g, r.last_name ?? '').replace(/\{campaign_name\}/g, r.campaign_name ?? '');

/** Texts over 160 plain characters (70 with Hebrew or emoji) go as several parts. */
export function smsParts(text: string) {
  const unicode = /[^\x00-\x7F£¥èéùìòÇØøÅå_ÆæßÉ¡ÄÖÑÜ§¿äöñüà€]/.test(text);
  const [one, many] = unicode ? [70, 67] : [160, 153];
  return text.length <= one ? 1 : Math.ceil(text.length / many);
}
const SmsCount = ({ text }: { text: string }) => {
  const parts = smsParts(text);
  return <small className="muted">{text.length} characters · {parts} text{parts === 1 ? '' : 's'} each{parts > 1 ? ' (long messages are split)' : ''}</small>;
};

async function copy(text: string, done: (m: string) => void) {
  try { await navigator.clipboard.writeText(text); done('Copied.'); } catch { done('Copy failed; select the text and copy it.'); }
}

/** The campaign's payment link: its Payment Link when that's a web address, otherwise its own payment page. */
export const paymentUrl = (c: Row) => (/^https?:\/\/\S+$/i.test(String(c.payment_link ?? '').trim())
  ? String(c.payment_link).trim() : `${window.location.origin}${import.meta.env.BASE_URL}give/${encodeURIComponent(c.id)}`);

// ---------------------------------------------------------------------------
// Sharing a campaign's payment link
// ---------------------------------------------------------------------------
export function ShareDialog({ campaign, onClose }: { campaign: Row; onClose: () => void }) {
  const link = paymentUrl(campaign);
  const name = campaign.external_name || campaign.internal_name || campaign.campaign_name;
  const [channel, setChannel] = useState<'email' | 'sms'>('email');
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [below, setBelow] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Row | null>(null);
  const [version, setVersion] = useState(0);
  const [org, setOrg] = useState<Row | null>(null);
  useEffect(() => { supabase.from('organizations').select('check_payee, zelle, ein').maybeSingle().then(({ data }) => setOrg(data)); }, []);
  const history = useQuery(async () => ((await supabase.rpc('campaign_shares', { p_campaign: campaign.id })).data ?? []) as Row[], [campaign.id, version]);

  const template = [
    channel === 'sms' ? link : `Donate here: ${link}`,
    org?.check_payee && `${channel === 'sms' ? 'Checks' : 'Make checks payable to'}: ${org.check_payee}`,
    org?.zelle && `Zelle: ${org.zelle}`,
    org?.ein && `EIN: ${org.ein}`,
  ].filter(Boolean).join('\n');
  const full = (message.trim() ? (below ? `${template}\n\n${message.trim()}` : `${message.trim()}\n\n${template}`) : template)
    + (channel === 'sms' ? '\nReply STOP to opt out.' : '');
  const recipients = to.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean);
  const origin = window.location.origin;
  const snippet = `<script src="${origin}/widget.js" data-campaign="${campaign.id}" data-label="Donate" async></script>`;
  const inline = `<script src="${origin}/widget.js" data-campaign="${campaign.id}" data-mode="inline" async></script>`;

  async function send() {
    setError(null);
    const { data, error: e } = await supabase.rpc('share_campaign_link', {
      p_campaign: campaign.id, p_channel: channel, p_recipients: recipients, p_subject: subject || null, p_message: message || null, p_message_below: below,
    });
    if (e) return setError(e.message);
    setResult(data as Row);
    setTo('');
    setVersion(v => v + 1);
  }

  return (
    <Overlay onClose={onClose}>
      <div className="form-head"><h2>Share {name}</h2><button type="button" className="icon-btn" title="Close" onClick={onClose}><X size={18} /></button></div>
      {!link ? (
        <p>This campaign has no payment link yet. An admin can add it in the campaign's details under Payment Link; the portal's own payment pages arrive later.</p>
      ) : (
        <>
          <div className="panel-box">
            <div className="share-link"><code>{link}</code><button type="button" className="btn" onClick={() => copy(link, setNote)}><Copy size={15} /> Copy link</button></div>
            <details><summary className="muted small">Donate widget for a website</summary>
              <p className="muted small">A Donate button that opens this campaign's form over the website:</p>
              <textarea className="snippet" readOnly rows={2} value={snippet} onFocus={e => e.target.select()} />
              <button type="button" className="btn" onClick={() => copy(snippet, setNote)}><Copy size={15} /> Copy button code</button>
              <p className="muted small">Or the whole form placed right in the page:</p>
              <textarea className="snippet" readOnly rows={2} value={inline} onFocus={e => e.target.select()} />
              <button type="button" className="btn" onClick={() => copy(inline, setNote)}><Copy size={15} /> Copy form code</button></details>
            {note && <p className="muted small">{note}</p>}
          </div>

          <div className="segmented">
            <button type="button" className={channel === 'email' ? 'on' : ''} onClick={() => setChannel('email')}><Mail size={15} /> Email</button>
            <button type="button" className={channel === 'sms' ? 'on' : ''} onClick={() => setChannel('sms')}><MessageSquare size={15} /> Text</button>
          </div>
          <div className="fields">
            <label className="field wide"><span>{channel === 'email' ? 'Email addresses' : 'Phone numbers'}</span>
              <textarea rows={2} value={to} onChange={e => setTo(e.target.value)} placeholder="Separate with commas or new lines" /></label>
            {channel === 'email' && <label className="field wide"><span>Subject</span><input value={subject} onChange={e => setSubject(e.target.value)} placeholder={`Support ${name}`} /></label>}
            <label className="field wide"><span>Your message (optional)</span><textarea rows={3} value={message} onChange={e => setMessage(e.target.value)} /></label>
            <label className="inline-check"><input type="checkbox" checked={below} onChange={e => setBelow(e.target.checked)} /> Put my message below the details</label>
          </div>
          <p className="muted small">What they'll get{channel === 'email' ? ', plus an unsubscribe link' : ''}:</p>
          <pre className="message-text">{full}</pre>
          {channel === 'sms' && <SmsCount text={full} />}
          {result && <div className="notice">Sent to {result.queued}.{(result.skipped as Row[]).length > 0 && ` Skipped: ${(result.skipped as Row[]).map(s => `${s.to} (${s.reason})`).join('; ')}`}</div>}
          {error && <div className="error">{error}</div>}
          <div className="form-actions"><div className="spacer" />
            <button type="button" className="btn primary" disabled={!recipients.length} onClick={send}><Send size={15} /> Send to {recipients.length || ''}</button></div>
        </>
      )}
      {(history.data as Row[] | undefined)?.length ? (
        <>
          <h3 className="section-title">Shared before</h3>
          <div className="table-wrap dialog-table"><table className="grid">
            <thead><tr><th>When</th><th>By</th><th>To</th><th>Status</th></tr></thead>
            <tbody>{(history.data as Row[]).map(h => (
              <tr key={h.id}><td>{dateTime(h.created_at)}</td><td>{h.created_by}</td><td>{h.to_address}</td><td><MessagePill status={h.status} /></td></tr>
            ))}</tbody>
          </table></div>
        </>
      ) : null}
    </Overlay>
  );
}

// ---------------------------------------------------------------------------
// Custom Outreach: compose
// ---------------------------------------------------------------------------
interface Recipient {
  key: string; kind: 'donor' | 'fundraiser' | 'address'; id?: string; address?: string; name: string;
  email?: string | null; phone?: string | null; first_name?: string | null; last_name?: string | null;
  campaign_id?: string | null; campaign_name?: string | null;
}

const GROUPS: [string, string][] = [
  ['campaign_donors', "A campaign's donors"], ['all_donors', 'All donors'], ['all_fundraisers', 'All fundraisers'], ['primary_fundraisers', 'Primary fundraisers'],
];

const toBase64 = (file: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
  r.onerror = () => reject(r.error);
  r.readAsDataURL(file);
});

export function OutreachPage() {
  const [channel, setChannel] = useState<'email' | 'sms' | 'both'>('email');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [smsBody, setSmsBody] = useState('');
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [donors, setDonors] = useState<Option[]>([]);
  const [managers, setManagers] = useState<Option[]>([]);
  const [campaigns, setCampaigns] = useState<Option[]>([]);
  const [typed, setTyped] = useState('');
  const [group, setGroup] = useState('campaign_donors');
  const [groupCampaign, setGroupCampaign] = useState<string | null>(null);
  const [later, setLater] = useState(false);
  const [when, setWhen] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [previewKey, setPreviewKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Row | null>(null);
  const templates = useQuery(async () => ((await supabase.from('outreach_templates').select('*').order('name')).data ?? []) as Row[], []);
  useEffect(() => { donorOptions().then(setDonors); managerOptions().then(setManagers); campaignOptions().then(setCampaigns); }, []);

  const add = (list: Recipient[]) => setRecipients(r => {
    const keys = new Set(r.map(x => x.key));
    return [...r, ...list.filter(x => !keys.has(x.key))];
  });
  async function addPerson(kind: 'donor' | 'fundraiser', id: string | null) {
    if (!id) return;
    const { data } = await supabase.from(kind === 'donor' ? 'donors' : 'managers').select(kind === 'donor' ? 'id, display_name, first_name, last_name, email, phone' : 'id, full_name, first_name, last_name, email, phone').eq('id', id).maybeSingle();
    const d = data as Row | null;
    if (d) add([{ key: `${kind}:${id}`, kind, id, name: d.display_name ?? d.full_name, email: d.email, phone: d.phone, first_name: d.first_name, last_name: d.last_name }]);
  }
  function addTyped() {
    add(typed.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean).map(a => ({ key: `address:${a.toLowerCase()}`, kind: 'address' as const, address: a, name: a, email: a.includes('@') ? a : null, phone: a.includes('@') ? null : a })));
    setTyped('');
  }
  async function addGroup() {
    setError(null);
    const { data, error: e } = await supabase.rpc('outreach_group', { p_group: group, p_campaign: groupCampaign });
    if (e) return setError(e.message);
    const campaignName = groupCampaign ? campaigns.find(c => c.value === groupCampaign)?.label.replace(/^\S+ - /, '') : null;
    add(((data ?? []) as Row[]).map(r => ({
      key: `${r.kind}:${r.id}`, kind: r.kind, id: r.id, name: r.name, email: r.email, phone: r.phone,
      first_name: String(r.name ?? '').split(' ')[0], last_name: String(r.name ?? '').split(' ').slice(1).join(' '),
      campaign_id: r.campaign_id, campaign_name: campaignName,
    })));
  }
  function applyTemplate(id: string) {
    const t = (templates.data as Row[] | undefined)?.find(x => x.id === id);
    if (!t) return;
    setSubject(t.subject ?? '');
    setBody(t.body ?? '');
    setSmsBody(t.sms_body ?? '');
  }
  async function saveTemplate() {
    const name = prompt('Name this template, for example "Annual Appeal Letter":');
    if (!name) return;
    const { error: e } = await supabase.rpc('save_outreach_template', { p_id: null, p_name: name, p_subject: subject, p_body: body, p_sms_body: smsBody });
    if (e) return setError(e.message);
    void templates.reload();
  }

  const reachable = recipients.filter(r => (channel !== 'sms' && r.email) || (channel !== 'email' && r.phone)).length;
  async function send() {
    if (!confirm(`${later ? 'Schedule' : 'Send'} this to ${reachable} recipient${reachable === 1 ? '' : 's'}?`)) return;
    setBusy(true);
    setError(null);
    try {
      const { data, error: e } = await supabase.rpc('send_outreach', {
        p_channel: channel, p_subject: subject, p_body: body, p_sms_body: smsBody,
        p_recipients: recipients.map(r => ({ kind: r.kind, id: r.id, address: r.address, campaign_id: r.campaign_id })),
        p_send_after: later && when ? new Date(when).toISOString() : null,
        p_attachment_name: file?.name ?? null, p_attachment: file ? await toBase64(file) : null,
      });
      if (e) throw new Error(e.message);
      setResult(data as Row);
      setRecipients([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const preview = recipients.find(r => r.key === previewKey) ?? recipients[0];
  const previewEmail = useMemo(() => preview && formatHtml(personalize(body, preview)), [preview, body]);
  const token = (t: string) => <button key={t} type="button" className="chip-btn" onClick={() => setBody(b => b + t)}>{t}</button>;
  return (
    <section className="view">
      <div className="view-head">
        <div className="view-title"><h1>New Message</h1><span className="count">Custom Outreach by email and text</span></div>
      </div>

      <div className="panel-box">
        <div className="fields">
          <label className="field"><span>Send by</span>
            <select value={channel} onChange={e => setChannel(e.target.value as typeof channel)}>
              <option value="email">Email</option><option value="sms">Text</option><option value="both">Email and text</option>
            </select></label>
          <label className="field"><span>Start from a template</span>
            <select value="" onChange={e => applyTemplate(e.target.value)}>
              <option value="">Choose…</option>{(templates.data as Row[] | undefined)?.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select></label>
        </div>
        {channel !== 'sms' && (
          <div className="fields">
            <label className="field wide"><span>Subject</span><input value={subject} onChange={e => setSubject(e.target.value)} /></label>
            <label className="field wide"><span>Email</span><textarea rows={8} value={body} onChange={e => setBody(e.target.value)} />
              <small className="muted">**bold**, *italic*; web addresses become links. Fill in per person: {['{first_name}', '{last_name}', '{campaign_name}'].map(token)}</small></label>
            <label className="field wide"><span><Paperclip size={13} /> PDF attachment (optional)</span>
              <input type="file" accept="application/pdf,.pdf" onChange={e => setFile(e.target.files?.[0] ?? null)} /></label>
          </div>
        )}
        {channel !== 'email' && (
          <div className="fields">
            <label className="field wide"><span>Text message</span><textarea rows={3} value={smsBody} onChange={e => setSmsBody(e.target.value)} />
              <SmsCount text={`${smsBody}\nReply STOP to opt out.`} /></label>
          </div>
        )}
        <div className="form-actions"><button type="button" className="btn" onClick={saveTemplate} disabled={!body && !smsBody}>Save as template</button></div>
      </div>

      <div className="panel-box">
        <h2>Recipients ({recipients.length})</h2>
        <div className="fields">
          <label className="field"><span>Add a donor</span><SearchSelect value={null} options={donors} onChange={v => addPerson('donor', v)} placeholder="Search donors" /></label>
          <label className="field"><span>Add a fundraiser</span><SearchSelect value={null} options={managers} onChange={v => addPerson('fundraiser', v)} placeholder="Search fundraisers" /></label>
          <label className="field"><span>Add a group</span>
            <select value={group} onChange={e => setGroup(e.target.value)}>{GROUPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
          {group === 'campaign_donors' && <label className="field"><span>Campaign</span><SearchSelect value={groupCampaign} options={campaigns} onChange={setGroupCampaign} placeholder="Choose a campaign" /></label>}
          <div className="field"><span>&nbsp;</span><button type="button" className="btn" disabled={group === 'campaign_donors' && !groupCampaign} onClick={addGroup}>Add group</button></div>
          <label className="field wide"><span>Or type addresses and numbers</span>
            <textarea rows={2} value={typed} onChange={e => setTyped(e.target.value)} placeholder="Separate with commas or new lines. They aren't saved as donors." /></label>
          <div className="field"><button type="button" className="btn" disabled={!typed.trim()} onClick={addTyped}>Add</button></div>
        </div>
        {recipients.length > 0 && (
          <div className="table-wrap dialog-table"><table className="grid">
            <thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Campaign</th><th /></tr></thead>
            <tbody>{recipients.map(r => (
              <tr key={r.key} className={(channel !== 'sms' && !r.email) && (channel !== 'email' && !r.phone) || (channel === 'email' && !r.email) || (channel === 'sms' && !r.phone) ? 'muted' : ''}>
                <td>{r.name}{r.kind === 'fundraiser' && <> <Pill>Fundraiser</Pill></>}</td><td>{r.email ?? '—'}</td><td>{r.phone ?? '—'}</td><td>{r.campaign_name ?? ''}</td>
                <td><button type="button" className="icon-btn" title="Remove" onClick={() => setRecipients(x => x.filter(y => y.key !== r.key))}><X size={15} /></button></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        {recipients.length > 0 && <p className="muted small">{reachable} can be reached by {channel === 'both' ? 'email or text' : channel === 'sms' ? 'text' : 'email'}. Greyed rows have no {channel === 'sms' ? 'phone' : 'address'} and are skipped. Anyone listed twice gets it once.</p>}
      </div>

      {preview && (channel !== 'sms' ? body : smsBody) && (
        <div className="panel-box">
          <h2>Preview for <select value={preview.key} onChange={e => setPreviewKey(e.target.value)}>{recipients.map(r => <option key={r.key} value={r.key}>{r.name}</option>)}</select></h2>
          {channel !== 'sms' && <><p><b>{personalize(subject, preview)}</b></p><div className="message-text" dangerouslySetInnerHTML={{ __html: previewEmail ?? '' }} /></>}
          {channel !== 'email' && <pre className="message-text">{personalize(smsBody, preview)}{'\n'}Reply STOP to opt out.</pre>}
        </div>
      )}

      <div className="panel-box">
        <label className="inline-check"><input type="checkbox" checked={later} onChange={e => setLater(e.target.checked)} /> Send later</label>
        {later && <label className="field"><span>When</span><input type="datetime-local" value={when} onChange={e => setWhen(e.target.value)} /></label>}
        {result && <div className="notice">{later ? 'Scheduled' : 'Sent'} to {result.queued}.{(result.skipped as Row[]).length > 0 && ` Skipped ${(result.skipped as Row[]).length}: ${(result.skipped as Row[]).map(s => `${s.to} (${s.reason})`).join('; ')}`} Track it in Outreach History.</div>}
        {error && <div className="error">{error}</div>}
        <div className="form-actions"><div className="spacer" />
          <button type="button" className="btn primary" disabled={busy || !reachable || (later && !when)} onClick={send}><Send size={15} /> {later ? 'Schedule' : 'Send'} to {reachable}</button></div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------
const rate = (n: number, of: number) => (of ? `${n} (${Math.round((n / of) * 100)}%)` : String(n));
const sendStatus = (r: Row) => (r.cancelled_at ? 'Cancelled' : new Date(r.send_after) > new Date() ? 'Scheduled' : r.waiting > 0 ? 'Sending' : 'Sent');

export function OutreachHistoryPage() {
  const [version, setVersion] = useState(0);
  const [open, setOpen] = useState<Row | null>(null);
  const q = useQuery(() => fetchAll((a, b) => supabase.from('outreach_list').select('*').order('created_at', { ascending: false }).range(a, b) as never), [version]);
  const columns: Column[] = [
    { key: 'created_at', label: 'Created', render: r => dateTime(r.created_at), value: r => r.created_at },
    { key: 'status', label: 'Status', value: sendStatus, render: r => <Pill tone={r.cancelled_at ? '' : sendStatus(r) === 'Sent' ? 'green' : 'blue'}>{sendStatus(r)}</Pill> },
    { key: 'channel', label: 'By', value: r => (r.channel === 'both' ? 'Email and text' : r.channel === 'sms' ? 'Text' : 'Email') },
    { key: 'subject', label: 'Subject or text', long: true, width: 260, value: r => r.subject ?? r.sms_body },
    { key: 'queued_count', label: 'Messages', align: 'right' },
    { key: 'delivered', label: 'Delivered', align: 'right' },
    { key: 'failed', label: 'Failed', align: 'right' },
    { key: 'opened', label: 'Opened', align: 'right', value: r => rate(r.opened, r.emails) },
    { key: 'clicked', label: 'Clicked', align: 'right', value: r => rate(r.clicked, r.emails) },
    { key: 'send_after', label: 'Send time', render: r => dateTime(r.send_after) },
    { key: 'created_by', label: 'Sent by', optional: true },
  ];
  return (
    <section className="view">
      <DataTable title="Outreach History" subtitle="Every outreach send, with delivery, opens and clicks. Opens and clicks are counted for email only."
        rows={(q.data as Row[]) ?? []} loading={q.loading} error={q.error} columns={columns} exportName="outreach" onOpen={setOpen} />
      {open && <OutreachDialog send={open} onClose={() => setOpen(null)} onChanged={() => { setOpen(null); setVersion(v => v + 1); }} />}
    </section>
  );
}

function OutreachDialog({ send: s, onClose, onChanged }: { send: Row; onClose: () => void; onChanged: () => void }) {
  const q = useQuery(async () => ((await supabase.from('messages').select('id, channel, to_name, to_address, status, error, opened_at, clicked_at')
    .eq('kind', 'outreach').eq('record_id', s.id).order('to_name')).data ?? []) as Row[], [s.id]);
  async function cancel() {
    if (!confirm('Call off the messages in this send that haven\'t gone yet?')) return;
    const { error } = await supabase.rpc('cancel_outreach', { p_id: s.id });
    if (error) return alert(error.message);
    onChanged();
  }
  return (
    <Overlay onClose={onClose}>
      <div className="form-head"><h2>{s.subject ?? 'Text message'} <Pill>{sendStatus(s)}</Pill></h2><button type="button" className="icon-btn" title="Close" onClick={onClose}><X size={18} /></button></div>
      <dl className="record-facts">
        <dt>Sent by</dt><dd>{s.created_by} · {dateTime(s.created_at)}</dd>
        <dt>Send time</dt><dd>{dateTime(s.send_after)}</dd>
        <dt>Recipients</dt><dd>{s.recipient_count} listed · {s.queued_count} messages · {(s.skipped as Row[]).length} skipped</dd>
        <dt>Email</dt><dd>{s.emails} sent · opened {rate(s.opened, s.emails)} · clicked {rate(s.clicked, s.emails)}</dd>
        {s.attachment_name && <><dt>Attachment</dt><dd>{s.attachment_name}</dd></>}
        {s.cancelled_at && <><dt>Cancelled</dt><dd>{dateTime(s.cancelled_at)} by {s.cancelled_by}</dd></>}
      </dl>
      {s.body && <pre className="message-text">{s.body}</pre>}
      {s.sms_body && <pre className="message-text">{s.sms_body}</pre>}
      {(s.skipped as Row[]).length > 0 && <p className="muted small">Skipped: {(s.skipped as Row[]).map(k => `${k.to} (${k.reason})`).join('; ')}</p>}
      <div className="table-wrap dialog-table"><table className="grid">
        <thead><tr><th>To</th><th>By</th><th>Status</th><th>Opened</th><th>Clicked</th></tr></thead>
        <tbody>{((q.data as Row[]) ?? []).map(m => (
          <tr key={m.id}><td>{m.to_name ? `${m.to_name} · ` : ''}{m.to_address}</td><td>{m.channel === 'sms' ? 'Text' : 'Email'}</td>
            <td><MessagePill status={m.status} />{m.error && m.status === 'failed' && <span className="muted small"> {m.error}</span>}</td>
            <td>{m.channel === 'email' ? (m.opened_at ? 'Yes' : 'No') : ''}</td><td>{m.channel === 'email' ? (m.clicked_at ? 'Yes' : 'No') : ''}</td></tr>
        ))}</tbody>
      </table></div>
      {!s.cancelled_at && s.waiting > 0 && (
        <div className="form-actions"><div className="spacer" /><button type="button" className="btn danger" onClick={cancel}>Cancel what hasn't gone</button></div>
      )}
    </Overlay>
  );
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------
export function OutreachTemplatesPage() {
  const [version, setVersion] = useState(0);
  const [open, setOpen] = useState<Row | null>(null);
  const q = useQuery(async () => ((await supabase.from('outreach_templates').select('*').order('name')).data ?? []) as Row[], [version]);
  const columns: Column[] = [
    { key: 'name', label: 'Name', render: r => <b>{r.name}</b>, value: r => r.name, width: 220 },
    { key: 'subject', label: 'Subject', width: 240 },
    { key: 'sms_body', label: 'Text', width: 240 },
    { key: 'updated_at', label: 'Updated', render: r => dateTime(r.updated_at) },
    { key: 'updated_by', label: 'By' },
  ];
  return (
    <section className="view">
      <DataTable title="Outreach Templates" subtitle="Saved messages to start from. {first_name}, {last_name} and {campaign_name} fill in per person."
        rows={(q.data as Row[]) ?? []} loading={q.loading} error={q.error} columns={columns} exportName="outreach-templates" onOpen={setOpen}
        actions={<button type="button" className="btn primary" onClick={() => setOpen({})}>New template</button>} />
      {open && <TemplateDialog template={open} onClose={() => setOpen(null)} onSaved={() => { setOpen(null); setVersion(v => v + 1); }} />}
    </section>
  );
}

function TemplateDialog({ template: t, onClose, onSaved }: { template: Row; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(t.name ?? '');
  const [subject, setSubject] = useState(t.subject ?? '');
  const [body, setBody] = useState(t.body ?? '');
  const [sms, setSms] = useState(t.sms_body ?? '');
  const [error, setError] = useState<string | null>(null);
  async function save() {
    const { error: e } = await supabase.rpc('save_outreach_template', { p_id: t.id ?? null, p_name: name, p_subject: subject, p_body: body, p_sms_body: sms });
    if (e) return setError(e.message);
    onSaved();
  }
  async function remove() {
    if (!confirm(`Delete the template "${t.name}"?`)) return;
    const { error: e } = await supabase.rpc('delete_outreach_template', { p_id: t.id });
    if (e) return setError(e.message);
    onSaved();
  }
  return (
    <Overlay onClose={onClose}>
      <div className="form-head"><h2>{t.id ? t.name : 'New template'}</h2><button type="button" className="icon-btn" title="Close" onClick={onClose}><X size={18} /></button></div>
      <div className="fields">
        <label className="field wide"><span>Name</span><input value={name} onChange={e => setName(e.target.value)} /></label>
        <label className="field wide"><span>Email subject</span><input value={subject} onChange={e => setSubject(e.target.value)} /></label>
        <label className="field wide"><span>Email</span><textarea rows={8} value={body} onChange={e => setBody(e.target.value)} /></label>
        <label className="field wide"><span>Text message</span><textarea rows={3} value={sms} onChange={e => setSms(e.target.value)} /><SmsCount text={sms} /></label>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="form-actions">
        {t.id && <button type="button" className="btn danger" onClick={remove}><Trash2 size={15} /> Delete</button>}
        <div className="spacer" /><button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={!name.trim()} onClick={save}>Save</button></div>
    </Overlay>
  );
}

// ---------------------------------------------------------------------------
// Unsubscribe, from the link in a marketing email. No sign-in; a click is needed, so link scanners
// that open every link in an email don't unsubscribe anyone.
// ---------------------------------------------------------------------------
export function UnsubscribePage({ token }: { token: string }) {
  const [state, setState] = useState<'ask' | 'done' | 'missing'>('ask');
  const [org, setOrg] = useState<string | null>(null);
  async function confirmIt() {
    const { data } = await supabase.rpc('unsubscribe_email', { p_token: token });
    if (!data) return setState('missing');
    setOrg(data as string);
    setState('done');
  }
  return (
    <div className="shared-missing">
      {state === 'ask' && <><h1>Unsubscribe?</h1><p>You'll stop getting messages like this one by email. Receipts for your donations still arrive.</p>
        <button type="button" className="btn primary" onClick={confirmIt}>Unsubscribe</button></>}
      {state === 'done' && <><h1>You're unsubscribed</h1><p>{org} won't send you messages like that one by email again.</p></>}
      {state === 'missing' && <><h1>This link doesn't work</h1><p>It may be incomplete. Reply to the email and ask to be taken off the list.</p></>}
    </div>
  );
}
