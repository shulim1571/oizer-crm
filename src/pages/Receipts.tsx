import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Printer, Send, X } from 'lucide-react';
import DataTable, { type Column } from '../components/DataTable';
import { Pill } from '../components/Pill';
import { useAuth } from '../lib/auth';
import { dateTime, localToday, money } from '../lib/format';
import { campaignOptions, managerOptions, type Option } from '../lib/lookups';
import { documentHtml, printPages, receiptPage, statementPage, type OrgDetails } from '../lib/receiptHtml';
import { SendDocumentDialog } from './Messaging';
import { fetchAll, supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';
import { Overlay } from './Pledges';

const ReceiptPill = ({ status }: { status: string }) => <Pill tone={status === 'issued' ? 'green' : ''}>{status === 'issued' ? 'Issued' : 'Voided'}</Pill>;

async function orgDetails(): Promise<OrgDetails> {
  const { data: org } = await supabase.rpc('current_org_id');
  const { data } = await supabase.from('organizations').select('name, legal_name, ein, address, phone, email, director_name, logo_url').eq('id', org).maybeSingle();
  return (data ?? { name: '' }) as OrgDetails;
}
async function directorSignature() {
  const { data } = await supabase.rpc('check_asset', { p_kind: 'director_signature', p_account: '' });
  const s = ((data ?? []) as Row[])[0];
  return s ? `data:${s.mime};base64,${s.data}` : null;
}

/** Receipt pages by id, in the order given. */
async function receiptPages(ids: string[]) {
  const { data, error } = await supabase.from('receipts').select('*').in('id', ids);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Row[];
  const corrects = rows.map(r => r.corrects_id).filter(Boolean);
  const numbers = corrects.length ? (await supabase.from('receipts').select('id, receipt_number').in('id', corrects)).data ?? [] : [];
  const [org, sig] = await Promise.all([orgDetails(), directorSignature()]);
  const byId = new Map(rows.map(r => [r.id, r]));
  return {
    title: rows.length === 1 ? rows[0].receipt_number as string : `${rows.length} receipts`,
    pages: ids.map(id => byId.get(id)).filter(Boolean).map(r => receiptPage({ ...r!, corrects_number: numbers.find(n => n.id === r!.corrects_id)?.receipt_number }, org, sig)),
  };
}

/** Prints receipts by id, in the order given. */
export async function printReceipts(ids: string[]) {
  const { title, pages } = await receiptPages(ids);
  printPages(title, pages);
}

export const receiptDocument = async (id: string) => {
  const { title, pages } = await receiptPages([id]);
  return documentHtml(title, pages);
};

// ---------------------------------------------------------------------------
// On a donation
// ---------------------------------------------------------------------------
export function ReceiptActions({ donationId }: { donationId: string }) {
  const [version, setVersion] = useState(0);
  const [issuing, setIssuing] = useState(false);
  const [correcting, setCorrecting] = useState<Row | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const q = useQuery(async () => (await supabase.from('receipts').select('*').contains('donation_ids', [donationId]).order('issued_at', { ascending: false })).data as Row[], [donationId, version]);
  const list = (q.data as Row[]) ?? [];
  const live = list.find(r => r.status === 'issued');
  const done = () => { setIssuing(false); setCorrecting(null); setVersion(v => v + 1); window.dispatchEvent(new Event('task-sheet-changed')); };
  return (
    <div className="donation-actions">
      {live ? (
        <>
          <span>Receipt <b>{live.receipt_number}</b>{Number(live.amount) !== Number(live.actual_amount) && ` for ${money(live.amount)}`}</span>
          <button type="button" className="btn" onClick={() => printReceipts([live.id]).catch(e => setError(e.message))}><Printer size={15} /> Print receipt</button>
          <button type="button" className="btn" onClick={() => setSending(true)}><Send size={15} /> Send receipt</button>
          <button type="button" className="btn" onClick={() => setCorrecting(live)}>Void & Correct</button>
        </>
      ) : (
        <button type="button" className="btn" onClick={() => setIssuing(true)}>Issue receipt</button>
      )}
      {list.filter(r => r !== live).map(r => <span key={r.id} className="muted small">{r.receipt_number} voided{r.void_reason ? `: ${r.void_reason}` : ''}</span>)}
      {error && <div className="error">{error}</div>}
      {issuing && <IssueReceiptDialog donationId={donationId} onClose={() => setIssuing(false)} onDone={done} />}
      {correcting && <CorrectReceiptDialog receipt={correcting} onClose={() => setCorrecting(null)} onDone={done} />}
      {sending && live && (
        <SendDocumentDialog kind="receipt" recordId={live.id} donorId={live.donor_id} campaignId={live.campaign_id} title={live.receipt_number}
          build={() => receiptDocument(live.id)} onClose={() => setSending(false)} />
      )}
    </div>
  );
}

function IssueReceiptDialog({ donationId, onClose, onDone }: { donationId: string; onClose: () => void; onDone: () => void }) {
  const [d, setD] = useState<Row | null>(null);
  const [text, setText] = useState<Row>({});
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState('');
  const [reason, setReason] = useState('');
  const [own, setOwn] = useState(false);
  const [hebrew, setHebrew] = useState('');
  const [english, setEnglish] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    supabase.from('donations').select('*, campaigns(external_name, internal_name), donors(display_name)').eq('id', donationId).single().then(({ data }) => {
      setD(data);
      setAmount(String(data?.amount ?? ''));
      setDate(String(data?.created_at ?? '').slice(0, 10));
      if (data?.campaign_id) supabase.rpc('receipt_text', { p_campaign: data.campaign_id }).then(({ data: t }) => setText(((t ?? []) as Row[])[0] ?? {}));
    });
  }, [donationId]);
  if (!d) return null;
  const partial = Number(amount) !== Number(d.amount);

  async function issue() {
    setError(null);
    const { data, error: e } = await supabase.rpc('issue_receipt', {
      p_donation: donationId, p_amount: partial ? Number(amount) : null, p_date: date || null, p_amount_reason: partial ? reason || null : null,
      p_hebrew_text: own ? hebrew || null : null, p_english_text: own ? english || null : null,
    });
    if (e) return setError(e.message);
    await printReceipts([data as string]).catch(err => setError(err.message));
    onDone();
  }

  return (
    <Overlay onClose={onClose}>
      <div className="form-head"><h2>Issue receipt</h2><button type="button" className="icon-btn" title="Close" onClick={onClose}><X size={18} /></button></div>
      <p className="muted small">{d.donors?.display_name ?? d.name} · {money(d.amount)} to {d.campaigns?.external_name || d.campaigns?.internal_name}. Receipt numbers are permanent; a mistake is fixed with Void & Correct.</p>
      <div className="fields">
        <label className="field"><span>Amount on the receipt</span><input type="number" step="0.01" min="0" value={amount} onChange={e => setAmount(e.target.value)} /></label>
        <label className="field"><span>Receipt date</span><input type="date" value={date} onChange={e => setDate(e.target.value)} /></label>
      </div>
      {partial && <label className="field"><span>Why a different amount (optional, kept in the activity log)</span><input value={reason} onChange={e => setReason(e.target.value)} /></label>}
      {!text.hebrew_text && !text.english_text && <p className="date-note">No receipt text is set up, so this receipt will have the official section only. <Link to="/receipt-text">Set it up</Link></p>}
      <label className="inline-check"><input type="checkbox" checked={own} onChange={e => { setOwn(e.target.checked); setHebrew(text.hebrew_text ?? ''); setEnglish(text.english_text ?? ''); }} /> Different text for this receipt only</label>
      {own && (
        <>
          <label className="field"><span>Hebrew blessing</span><textarea dir="rtl" rows={3} value={hebrew} onChange={e => setHebrew(e.target.value)} /></label>
          <label className="field"><span>English acknowledgment</span><textarea rows={3} value={english} onChange={e => setEnglish(e.target.value)} /></label>
        </>
      )}
      {error && <div className="error">{error}</div>}
      <div className="form-actions"><div className="spacer" /><button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={!(Number(amount) > 0)} onClick={issue}><Printer size={15} /> Issue and print</button></div>
    </Overlay>
  );
}

function CorrectReceiptDialog({ receipt, onClose, onDone }: { receipt: Row; onClose: () => void; onDone: () => void }) {
  const [amount, setAmount] = useState(String(receipt.amount));
  const [date, setDate] = useState(String(receipt.receipt_date).slice(0, 10));
  const [name, setName] = useState(receipt.donor_name ?? '');
  const [address, setAddress] = useState(receipt.donor_address ?? '');
  const [campaign, setCampaign] = useState(receipt.campaign_name ?? '');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  async function correct() {
    setError(null);
    const { data, error: e } = await supabase.rpc('correct_receipt', {
      p_receipt: receipt.id, p_amount: Number(amount), p_date: date, p_donor_name: name, p_donor_address: address || null, p_campaign_name: campaign, p_reason: reason || null,
    });
    if (e) return setError(e.message);
    await printReceipts([data as string]).catch(err => setError(err.message));
    onDone();
  }
  async function voidOnly() {
    const why = prompt(`Void ${receipt.receipt_number} without a replacement? Reason:`);
    if (!why) return;
    const { error: e } = await supabase.rpc('void_receipt', { p_receipt: receipt.id, p_reason: why });
    if (e) return setError(e.message);
    onDone();
  }
  return (
    <Overlay onClose={onClose}>
      <div className="form-head"><h2>Void & Correct {receipt.receipt_number}</h2><button type="button" className="icon-btn" title="Close" onClick={onClose}><X size={18} /></button></div>
      <p className="muted small">The old receipt stays on record as voided. The corrected one gets a new number and points back to it.</p>
      <div className="fields">
        <label className="field"><span>Amount</span><input type="number" step="0.01" min="0" value={amount} onChange={e => setAmount(e.target.value)} /></label>
        <label className="field"><span>Receipt date</span><input type="date" value={date} onChange={e => setDate(e.target.value)} /></label>
        <label className="field"><span>Donor name</span><input value={name} onChange={e => setName(e.target.value)} /></label>
        <label className="field"><span>Campaign name</span><input value={campaign} onChange={e => setCampaign(e.target.value)} /></label>
      </div>
      <label className="field"><span>Donor address</span><textarea rows={2} value={address} onChange={e => setAddress(e.target.value)} /></label>
      <label className="field"><span>What was wrong</span><input value={reason} onChange={e => setReason(e.target.value)} /></label>
      {error && <div className="error">{error}</div>}
      <div className="form-actions">
        <button type="button" className="btn danger" onClick={voidOnly}>Void only</button>
        <div className="spacer" />
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={!(Number(amount) > 0)} onClick={correct}>Void, correct and print</button>
      </div>
    </Overlay>
  );
}

// ---------------------------------------------------------------------------
// The receipts list, and receipting a date range at once
// ---------------------------------------------------------------------------
export function ReceiptsPage() {
  const [version, setVersion] = useState(0);
  const [open, setOpen] = useState<Row | null>(null);
  const [bulk, setBulk] = useState(false);
  const q = useQuery(
    () => fetchAll((a, b) => supabase.from('receipts').select('*').order('issued_at', { ascending: false }).range(a, b) as never),
    [version],
  );
  const columns: Column[] = [
    { key: 'receipt_number', label: 'Receipt', render: r => <b>{r.receipt_number}</b>, value: r => r.receipt_number },
    { key: 'status', label: 'Status', value: r => r.status, render: r => <ReceiptPill status={r.status} /> },
    { key: 'receipt_date', label: 'Date' },
    { key: 'donor_name', label: 'Donor', width: 180 },
    { key: 'amount', label: 'Amount', render: r => money(r.amount), align: 'right' },
    { key: 'campaign_name', label: 'Campaign', width: 180 },
    { key: 'void_reason', label: 'Voided because' },
    { key: 'issued_at', label: 'Issued', render: r => dateTime(r.issued_at) },
    { key: 'issued_by', label: 'By' },
  ];
  return (
    <section className="view">
      <DataTable
        title="Receipts"
        subtitle="Search by receipt number, donor or campaign."
        rows={(q.data as Row[]) ?? []}
        loading={q.loading}
        error={q.error}
        columns={columns}
        exportName="receipts"
        onOpen={setOpen}
        actions={<button type="button" className="btn primary" onClick={() => setBulk(true)}>Receipt a date range</button>}
      />
      {open && (
        <Overlay onClose={() => setOpen(null)}>
          <div className="form-head"><h2>{open.receipt_number} <ReceiptPill status={open.status} /></h2><button type="button" className="icon-btn" title="Close" onClick={() => setOpen(null)}><X size={18} /></button></div>
          <dl className="record-facts">
            <dt>Donor</dt><dd>{open.donor_name}{open.donor_id && <> · <Link to={`/donors/${encodeURIComponent(open.donor_id)}`}>profile</Link></>}</dd>
            <dt>Amount</dt><dd>{money(open.amount)}{Number(open.amount) !== Number(open.actual_amount) && ` (donation ${money(open.actual_amount)})`}</dd>
            <dt>Date</dt><dd>{open.receipt_date}</dd>
            <dt>Campaign</dt><dd>{open.campaign_name}</dd>
            {open.status === 'voided' && <><dt>Voided</dt><dd>{dateTime(open.voided_at)} by {open.voided_by}: {open.void_reason}</dd></>}
          </dl>
          <ReceiptActions donationId={open.donation_id} />
          <div className="form-actions"><div className="spacer" />
            <button type="button" className="btn" onClick={() => printReceipts([open.id])}><Printer size={15} /> Print this receipt</button></div>
        </Overlay>
      )}
      {bulk && <BulkReceipts onClose={() => setBulk(false)} onDone={() => { setBulk(false); setVersion(v => v + 1); }} />}
    </section>
  );
}

function BulkReceipts({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const first = localToday().slice(0, 8) + '01';
  const [from, setFrom] = useState(first);
  const [to, setTo] = useState(localToday());
  const [list, setList] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function preview() {
    setError(null);
    const { data, error: e } = await supabase.rpc('receipt_candidates', { p_from: from, p_to: to });
    if (e) return setError(e.message);
    setList((data ?? []) as Row[]);
  }
  async function issueAll() {
    if (!list?.length) return;
    setBusy(true);
    const ids: string[] = [];
    for (const d of list) {
      const { data, error: e } = await supabase.rpc('issue_receipt', { p_donation: d.donation_id });
      if (e) { setError(`${d.donor_name}: ${e.message}`); continue; }
      ids.push(data as string);
    }
    if (ids.length) await printReceipts(ids).catch(err => setError(err.message));
    setBusy(false);
    onDone();
  }
  return (
    <Overlay onClose={onClose}>
      <div className="form-head"><h2>Receipt a date range</h2><button type="button" className="icon-btn" title="Close" onClick={onClose}><X size={18} /></button></div>
      <p className="muted small">Lists completed donations in the range that have no receipt yet, leaving out DAF money and vouchers.</p>
      <div className="fields">
        <label className="field"><span>From</span><input type="date" value={from} onChange={e => { setFrom(e.target.value); setList(null); }} /></label>
        <label className="field"><span>To</span><input type="date" value={to} onChange={e => { setTo(e.target.value); setList(null); }} /></label>
      </div>
      {list && (
        <div className="table-wrap dialog-table"><table className="grid">
          <thead><tr><th>Date</th><th>Donor</th><th>Campaign</th><th className="right">Amount</th></tr></thead>
          <tbody>{list.map(d => <tr key={d.donation_id}><td>{dateTime(d.created_at)}</td><td>{d.donor_name}</td><td>{d.campaign_id}</td><td className="right">{money(d.amount)}</td></tr>)}</tbody>
        </table></div>
      )}
      {list && <p><b>{list.length}</b> receipt{list.length === 1 ? '' : 's'} to {new Set(list.map(d => d.donor_name)).size} donor{new Set(list.map(d => d.donor_name)).size === 1 ? '' : 's'}.</p>}
      {error && <div className="error">{error}</div>}
      <div className="form-actions">
        <button type="button" className="btn" onClick={preview}>Preview</button>
        <div className="spacer" />
        <button type="button" className="btn primary" disabled={busy || !list?.length} onClick={issueAll}><Printer size={15} /> Issue {list?.length ?? ''} and print</button>
      </div>
    </Overlay>
  );
}

// ---------------------------------------------------------------------------
// Receipt text: Settings (default), fundraiser and campaign
// ---------------------------------------------------------------------------
export function ReceiptTextCard({ level, refId, title }: { level: 'default' | 'fundraiser' | 'campaign'; refId: string; title: string }) {
  const [v, setV] = useState<Row>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    supabase.from('receipt_templates').select('*').eq('level', level).eq('ref_id', refId).maybeSingle().then(({ data }) => setV(data ?? {}));
  }, [level, refId, version]);
  const set = (k: string, val: string) => { setMsg(null); setV(p => ({ ...p, [k]: val })); };
  async function save(clear = false) {
    setError(null);
    const { error: e } = await supabase.rpc('save_receipt_template', {
      p_level: level, p_ref: refId, p_hebrew_salutation: clear ? null : v.hebrew_salutation ?? null, p_hebrew_text: clear ? null : v.hebrew_text ?? null, p_english_text: clear ? null : v.english_text ?? null,
    });
    if (e) return setError(e.message);
    setMsg(clear ? 'Back to the default.' : 'Saved.');
    setVersion(x => x + 1);
    window.dispatchEvent(new Event('task-sheet-changed'));
  }
  async function preview() {
    const [org, sig] = await Promise.all([orgDetails(), directorSignature()]);
    printPages('Receipt preview', [receiptPage({
      status: 'issued', receipt_number: 'R-PREVIEW', receipt_date: localToday(), amount: 180, actual_amount: 180, donor_title: 'Mr.', donor_name: 'Sample Donor',
      donor_address: '1 Sample St\nBrooklyn, NY 11219', hebrew_name: 'ר׳ ישראל ישראלי', campaign_name: 'Sample campaign',
      hebrew_salutation: v.hebrew_salutation, hebrew_text: v.hebrew_text, english_text: v.english_text,
    }, org, sig)]);
  }
  return (
    <div className="card">
      <h3>{title}</h3>
      <p className="muted small">{level === 'default'
        ? 'Used on every receipt unless a fundraiser or campaign has its own. A section left empty is left off the receipt.'
        : 'Leave a box empty to use the next level up. Campaign text wins over the fundraiser\'s, which wins over the default.'}
        {' '}You can write {'{amount}'}, {'{date}'}, {'{campaign}'} and {'{name}'} in the text.</p>
      <label className="field"><span>Hebrew salutation</span><input dir="rtl" value={v.hebrew_salutation ?? ''} onChange={e => set('hebrew_salutation', e.target.value)} placeholder="לכבוד ידידנו" /></label>
      <label className="field"><span>Hebrew blessing</span><textarea dir="rtl" rows={4} value={v.hebrew_text ?? ''} onChange={e => set('hebrew_text', e.target.value)} /></label>
      <label className="field"><span>English acknowledgment</span><textarea rows={4} value={v.english_text ?? ''} onChange={e => set('english_text', e.target.value)} /></label>
      {msg && <div className="notice">{msg}</div>}
      {error && <div className="error">{error}</div>}
      <div className="form-actions">
        <button type="button" className="btn" onClick={preview}>Preview</button>
        {level !== 'default' && <button type="button" className="btn" onClick={() => save(true)}>Reset to default</button>}
        <div className="spacer" />
        <button type="button" className="btn primary" onClick={() => save()}>Save</button>
      </div>
    </div>
  );
}

export function ReceiptTextPage() {
  const [sig, setSig] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { directorSignature().then(setSig); }, []);
  async function upload(file: File) {
    setError(null);
    const { toBase64 } = await import('../lib/checkPdf');
    const { error: e } = await supabase.rpc('save_check_asset', { p_kind: 'director_signature', p_account: null, p_base64: await toBase64(file), p_mime: file.type, p_file_name: file.name });
    if (e) return setError(e.message);
    setSig(await directorSignature());
  }
  return (
    <section className="view narrow">
      <ReceiptTextCard level="default" refId="" title="Receipt text" />
      <div className="card">
        <h3>Director's signature</h3>
        <p className="muted small">Printed under the English acknowledgment, with the director's name from <Link to="/organization">Organization</Link>. The organization's name, tax ID, address and logo come from there too.</p>
        {sig && <img src={sig} alt="Director's signature" style={{ maxHeight: 60 }} />}
        <label className="field"><span>Signature image (PNG or JPG)</span><input type="file" accept="image/png,image/jpeg" onChange={e => e.target.files?.[0] && upload(e.target.files[0])} /></label>
        {error && <div className="error">{error}</div>}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// On the donor's page: receipt history and year-end statements
// ---------------------------------------------------------------------------
export function DonorReceipts({ donor }: { donor: Row }) {
  const { isAdmin } = useAuth();
  const [stating, setStating] = useState(false);
  const [version, setVersion] = useState(0);
  const q = useQuery(async () => {
    const [r, s] = await Promise.all([
      supabase.from('receipts').select('id, receipt_number, status, amount, receipt_date, void_reason, corrects_id').eq('donor_id', donor.id).order('issued_at', { ascending: false }),
      isAdmin ? supabase.from('tax_statements').select('*').eq('donor_id', donor.id).order('generated_at', { ascending: false }) : Promise.resolve({ data: [] }),
    ]);
    return { receipts: (r.data ?? []) as Row[], statements: (s.data ?? []) as Row[] };
  }, [donor.id, version, isAdmin]);
  return (
    <div className="card">
      <div className="dialog-section"><h3>Receipts</h3>
        {isAdmin && <button type="button" className="link" onClick={() => setStating(true)}>Year-end tax statement</button>}
      </div>
      <ul className="plain">
        {(q.data?.receipts ?? []).map(r => (
          <li key={r.id}>
            {isAdmin ? <button type="button" className="link" onClick={() => printReceipts([r.id])}>{r.receipt_number}</button> : <b>{r.receipt_number}</b>}
            {' '}{money(r.amount)} · {r.receipt_date} <ReceiptPill status={r.status} />{r.void_reason && <span className="muted small"> {r.void_reason}</span>}
          </li>
        ))}
        {!q.loading && !q.data?.receipts.length && <li className="muted">No receipts yet</li>}
      </ul>
      {isAdmin && (q.data?.statements.length ?? 0) > 0 && (
        <>
          <h3>Statements</h3>
          <ul className="plain">
            {q.data!.statements.map(s => (
              <li key={s.id}>{s.tax_year} · {s.scope === 'all' ? 'all campaigns' : s.scope === 'fundraiser' ? `fundraiser ${s.manager_id}` : (s.campaign_ids ?? []).join(', ')} · {money(s.total)}
                {s.revised && <Pill>Revised</Pill>}<span className="muted small"> {s.generated_by}, {dateTime(s.generated_at)}</span></li>
            ))}
          </ul>
        </>
      )}
      {stating && <StatementDialog donor={donor} onClose={() => setStating(false)} onDone={() => { setStating(false); setVersion(v => v + 1); }} />}
    </div>
  );
}

function StatementDialog({ donor, onClose, onDone }: { donor: Row; onClose: () => void; onDone: () => void }) {
  const [year, setYear] = useState(new Date().getFullYear());
  const [scope, setScope] = useState<'all' | 'campaigns' | 'fundraiser'>('all');
  const [campaigns, setCampaigns] = useState<string[]>([]);
  const [manager, setManager] = useState('');
  const [campaignOpts, setCampaignOpts] = useState<Option[]>([]);
  const [managerOpts, setManagerOpts] = useState<Option[]>([]);
  const [items, setItems] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { campaignOptions().then(setCampaignOpts); managerOptions().then(setManagerOpts); }, []);
  const args = { p_donor: donor.id, p_year: year, p_campaigns: scope === 'campaigns' && campaigns.length ? campaigns : null, p_manager: scope === 'fundraiser' && manager ? manager : null };
  useEffect(() => {
    setItems(null);
    supabase.rpc('statement_items', args).then(({ data, error: e }) => (e ? setError(e.message) : setItems((data ?? []) as Row[])));
  }, [year, scope, campaigns.join(','), manager]); // eslint-disable-line react-hooks/exhaustive-deps
  const scopeText = scope === 'all' ? 'All campaigns' : scope === 'fundraiser' ? `Campaigns of ${managerOpts.find(m => m.value === manager)?.label ?? ''}` : `Campaigns ${campaigns.join(', ')}`;
  const [sendingId, setSendingId] = useState<string | null>(null);
  const title = `Statement ${year} ${donor.display_name}`;
  async function print() {
    setError(null);
    const { error: e } = await supabase.rpc('log_tax_statement', args);
    if (e) return setError(e.message);
    printPages(title, [statementPage({ donor, year, items: items ?? [], scope: scopeText }, await orgDetails())]);
    onDone();
  }
  async function send() {
    setError(null);
    const { data, error: e } = await supabase.rpc('log_tax_statement', args);
    if (e) return setError(e.message);
    setSendingId(data as string);
  }
  if (sendingId) {
    return (
      <SendDocumentDialog kind="statement" recordId={sendingId} donorId={donor.id} title={`${year} giving statement`}
        build={async () => documentHtml(title, [statementPage({ donor, year, items: items ?? [], scope: scopeText }, await orgDetails())])}
        onClose={onDone} />
    );
  }
  return (
    <Overlay onClose={onClose}>
      <div className="form-head"><h2>Year-end tax statement</h2><button type="button" className="icon-btn" title="Close" onClick={onClose}><X size={18} /></button></div>
      <div className="fields">
        <label className="field"><span>Tax year</span><input type="number" value={year} onChange={e => setYear(Number(e.target.value))} /></label>
        <label className="field"><span>Covering</span>
          <select value={scope} onChange={e => setScope(e.target.value as typeof scope)}>
            <option value="all">All campaigns</option><option value="campaigns">Specific campaigns</option><option value="fundraiser">One fundraiser's campaigns</option>
          </select>
        </label>
        {scope === 'fundraiser' && (
          <label className="field"><span>Fundraiser</span>
            <select value={manager} onChange={e => setManager(e.target.value)}><option value="">Choose…</option>{managerOpts.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}</select>
          </label>
        )}
      </div>
      {scope === 'campaigns' && (
        <div className="pick-list">
          {campaignOpts.map(c => (
            <label key={c.value} className="inline-check"><input type="checkbox" checked={campaigns.includes(c.value)} onChange={e => setCampaigns(x => (e.target.checked ? [...x, c.value] : x.filter(v => v !== c.value)))} /> {c.label}</label>
          ))}
        </div>
      )}
      {items && (
        <div className="table-wrap dialog-table"><table className="grid">
          <thead><tr><th>Date</th><th>Campaign</th><th>Receipt</th><th className="right">Amount</th></tr></thead>
          <tbody>{items.map(i => <tr key={i.donation_id}><td>{i.gift_date}</td><td>{i.campaign_name}</td><td>{i.receipt_number}</td><td className="right">{money(i.amount)}</td></tr>)}</tbody>
          <tfoot><tr><td colSpan={3}><b>Total</b></td><td className="right"><b>{money(items.reduce((t, i) => t + Number(i.amount), 0))}</b></td></tr></tfoot>
        </table></div>
      )}
      <p className="muted small">DAF grants and vouchers are left out; the DAF sends the donor its own paperwork. Each statement printed is logged on the donor for good.</p>
      {error && <div className="error">{error}</div>}
      <div className="form-actions"><div className="spacer" /><button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn" disabled={!items || (scope === 'fundraiser' && !manager)} onClick={send}><Send size={15} /> Send statement</button>
        <button type="button" className="btn primary" disabled={!items || (scope === 'fundraiser' && !manager)} onClick={print}><Printer size={15} /> Print statement</button></div>
    </Overlay>
  );
}
