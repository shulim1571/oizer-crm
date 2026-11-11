import { bytesToBase64, fromHex } from '../lib/base64';
import { STALE_MESSAGE, friendlyError, isStaleChunkError } from '../lib/staleChunk';
import RowMenu from '../components/RowMenu';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Printer, TriangleAlert, X } from 'lucide-react';
import DataTable, { type Column } from '../components/DataTable';
import { Pill } from '../components/Pill';
import { dateTime, money } from '../lib/format';
import { accountOptions, type Option } from '../lib/lookups';
import { fetchAll, supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';
import type { CheckData } from '../lib/checkPdf';
import { trimSignature } from '../lib/signatureTrim';
import { Overlay } from './Pledges';

// The PDF library is large, so it loads only when a check is printed.
const pdf = () => import('../lib/checkPdf');

const STATUS: Record<string, { label: string; tone: 'green' | 'red' | 'amber' | 'blue' | '' }> = {
  outstanding: { label: 'Outstanding', tone: 'blue' },
  cleared: { label: 'Cleared', tone: 'green' },
  voided: { label: 'Voided', tone: '' },
  lost: { label: 'Lost', tone: 'red' },
};
const CheckPill = ({ status }: { status: string }) => <Pill tone={STATUS[status]?.tone ?? ''}>{STATUS[status]?.label ?? status}</Pill>;
const usDate = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return `${m}/${d}/${y}`; };

async function asset(kind: 'signature' | 'micr_font', account = '') {
  const { data } = await supabase.rpc('check_asset', { p_kind: kind, p_account: account });
  return ((data ?? []) as Row[])[0] ?? null;
}

async function settingsFor(account: string) {
  const { data } = await supabase.from('account_check_settings').select('*').eq('account_id', account).maybeSingle();
  return data as Row | null;
}
const ready = (s: Row | null) => !!(s?.routing_number && s?.account_number && s?.next_check_number);

/** Everything printed on a check, from the account's settings and its files. */
async function checkData(s: Row, account: string, c: { checkNumber: number; date: string; payee: string; amount: number; memo?: string | null; campaign?: string | null }, sample = false): Promise<CheckData> {
  const [sig, font] = await Promise.all([asset('signature', account), asset('micr_font')]);
  return {
    ...c,
    printName: s.print_name ?? '', printAddress: s.print_address, bankName: s.bank_name ?? '',
    routing: s.routing_number ?? '000000000', account: s.account_number ?? '0000',
    offsetX: Number(s.offset_x), offsetY: Number(s.offset_y),
    // Trimmed to the writing, so it sits on the signature line whatever margins the file has.
    signature: sig ? await trimSignature({ bytes: fromHex(sig.data_hex, 'signature file'), mime: sig.mime }) : null,
    micrFont: font ? { bytes: fromHex(font.data_hex, 'MICR font file'), transit: font.transit_char, onUs: font.onus_char } : null,
    sample,
  };
}

async function openPdf(data: CheckData, fileName: string) {
  const { buildCheckPdf } = await pdf();
  const bytes = await buildCheckPdf(data);
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** Prints a check again from the register, with the same number. */
export async function reprintCheck(checkId: string) {
  const { data: k } = await supabase.from('check_register').select('*').eq('id', checkId).single();
  const s = await settingsFor(k.account_id);
  if (!s) throw new Error('This account has no check settings');
  await openPdf(await checkData(s, k.account_id, {
    checkNumber: k.check_number, date: usDate(k.check_date), payee: k.payee, amount: Number(k.amount), memo: k.memo, campaign: k.campaign_name,
  }), `check-${k.check_number}.pdf`);
}

// ---------------------------------------------------------------------------
// On a payout: print its check, or see the one already printed
// ---------------------------------------------------------------------------
export function PayoutCheckActions({ record, onDone }: { record: Row; onDone: (row: Row) => void }) {
  const [checks, setChecks] = useState<Row[]>([]);
  const [printing, setPrinting] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    supabase.from('checks').select('*').eq('expense_id', record.id).order('issued_at', { ascending: false }).then(({ data }) => setChecks(data ?? []));
  }, [record.id, version]);
  const live = checks.find(k => k.status === 'outstanding' || k.status === 'cleared');
  return (
    <div className="donation-actions">
      {live ? (
        <>
          <span>Check #{live.check_number} <CheckPill status={live.status} /></span>
          <button type="button" className="btn" onClick={() => reprintCheck(live.id).catch(e => alert(friendlyError(e)))}><Printer size={15} /> Print again</button>
          <Link to="/checks" className="btn">Check register</Link>
        </>
      ) : (
        <button type="button" className="btn" onClick={() => setPrinting(true)}><Printer size={15} /> Print check</button>
      )}
      {checks.filter(k => k !== live).map(k => <span key={k.id} className="muted small">#{k.check_number} {STATUS[k.status]?.label.toLowerCase()}{k.status_reason ? `: ${k.status_reason}` : ''}</span>)}
      {printing && <PrintCheckDialog payout={record} onClose={() => setPrinting(false)} onDone={() => { setPrinting(false); setVersion(v => v + 1); onDone(record); }} />}
    </div>
  );
}

function PrintCheckDialog({ payout, onClose, onDone }: { payout: Row; onClose: () => void; onDone: () => void }) {
  const [accounts, setAccounts] = useState<Option[]>([]);
  const [account, setAccount] = useState<string>(payout.account_id ?? '');
  const [settings, setSettings] = useState<Row | null>(null);
  const [memo, setMemo] = useState(payout.memo ?? '');
  const [hasFont, setHasFont] = useState<boolean | null>(null);
  const [campaign, setCampaign] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The check printer is loaded now, before anything is recorded: a page opened before a deploy can't load it,
  // and then nothing should be recorded at all (Moshe Henig's "print check doesn't work").
  const [printer, setPrinter] = useState<'loading' | 'ready' | 'stale'>('loading');
  useEffect(() => { pdf().then(() => setPrinter('ready'), e => setPrinter(isStaleChunkError(e) ? 'stale' : 'ready')); }, []);
  useEffect(() => {
    accountOptions().then(setAccounts);
    asset('micr_font').then(f => setHasFont(!!f));
    supabase.from('campaigns').select('internal_name, external_name').eq('id', payout.campaign_id).maybeSingle()
      // The memo defaults to the campaign ID (Moshe Henig, 2026-11-11); still editable, and a saved memo is kept.
      .then(({ data }) => { const n = data?.external_name || data?.internal_name || ''; setCampaign(n); setMemo((m: string) => m || payout.campaign_id || ''); });
  }, [payout.campaign_id]);
  useEffect(() => { setSettings(null); if (account) settingsFor(account).then(setSettings); }, [account]);
  const today = new Date();
  const date = `${today.getMonth() + 1}/${today.getDate()}/${today.getFullYear()}`;

  async function preview() {
    if (!settings) return;
    setError(null);
    try {
      await openPdf(await checkData(settings, account, { checkNumber: settings.next_check_number, date, payee: payout.payee, amount: Number(payout.amount), memo, campaign }, true), 'check-preview.pdf');
    } catch (e) {
      setError(friendlyError(e));
    }
  }
  async function issue() {
    if (!settings) return;
    setBusy(true);
    setError(null);
    const { data, error: e } = await supabase.rpc('issue_check', { p_payout: payout.id, p_account: account, p_memo: memo || null });
    if (e) { setBusy(false); return setError(e.message); }
    const n = ((data ?? []) as Row[])[0].check_number;
    try {
      await openPdf(await checkData(settings, account, { checkNumber: n, date, payee: payout.payee, amount: Number(payout.amount), memo, campaign }), `check-${n}.pdf`);
    } catch (e) {
      // The check is recorded; only the PDF failed. Say so, so it's printed again rather than issued twice.
      setBusy(false);
      return setError(`Check #${n} was recorded, but its PDF couldn't be made: ${friendlyError(e)} Then use "Print again" on this payout.`);
    }
    setBusy(false);
    onDone();
  }

  return (
    <Overlay onClose={onClose}>
      <div className="form-head"><h2>Print a check</h2><button type="button" className="icon-btn" title="Close" onClick={onClose}><X size={18} /></button></div>
      <dl className="record-facts">
        <dt>Pay to</dt><dd>{payout.payee || <span className="error">Choose a payee on the payout first</span>}</dd>
        <dt>Amount</dt><dd>{money(payout.amount)}</dd>
      </dl>
      <label className="field"><span>Draw from</span>
        <select value={account} onChange={e => setAccount(e.target.value)}>
          <option value="">Choose a bank account…</option>
          {accounts.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
        </select>
      </label>
      {account && settings !== null && !ready(settings) && (
        <div className="error">Set this account's routing number, account number and starting check number first. <Link to={`/accounts/${encodeURIComponent(account)}`}>Open the account</Link></div>
      )}
      {account && settings === null && <p className="muted small">No check settings for this account yet. <Link to={`/accounts/${encodeURIComponent(account)}`}>Set them up</Link></p>}
      {ready(settings) && <p className="muted small">This will be check #{settings!.next_check_number} on {settings!.bank_name}.</p>}
      <label className="field"><span>Memo</span><input value={memo} onChange={e => setMemo(e.target.value)} /></label>
      {hasFont === false && <p className="date-note"><TriangleAlert size={14} /> No MICR font is set up, so checks can't be printed yet. <Link to="/checks">Add it on the Checks page</Link>.</p>}
      {printer === 'stale' && (
        <div className="error">{STALE_MESSAGE} <button type="button" className="btn" onClick={() => window.location.reload()}>Reload</button></div>
      )}
      {error && <div className="error">{error}</div>}
      <div className="form-actions">
        <button type="button" className="btn" disabled={!ready(settings) || printer !== 'ready'} onClick={preview}>Preview (marked VOID)</button>
        <div className="spacer" />
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={busy || !ready(settings) || !hasFont || !payout.payee || printer !== 'ready'} onClick={issue}>Print and record check</button>
      </div>
    </Overlay>
  );
}

// ---------------------------------------------------------------------------
// The account's check settings, on its page
// ---------------------------------------------------------------------------
export function CheckSettingsCard({ accountId }: { accountId: string }) {
  const [s, setS] = useState<Row>({});
  const [sig, setSig] = useState<Row | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    settingsFor(accountId).then(r => setS(r ?? { offset_x: 0, offset_y: 0 }));
    asset('signature', accountId).then(setSig);
  }, [accountId, version]);
  const set = (k: string, v: unknown) => { setSaved(false); setS(prev => ({ ...prev, [k]: v })); };

  async function save() {
    setError(null);
    const { error: e } = await supabase.rpc('save_check_settings', {
      p_account: accountId, p_print_name: s.print_name ?? null, p_print_address: s.print_address ?? null, p_bank_name: s.bank_name ?? null,
      p_routing: s.routing_number ?? null, p_account_number: s.account_number ?? null,
      p_next_number: s.next_check_number ? Number(s.next_check_number) : null, p_offset_x: Number(s.offset_x || 0), p_offset_y: Number(s.offset_y || 0),
    });
    if (e) return setError(e.message);
    setSaved(true);
    setVersion(v => v + 1);
  }
  async function upload(file: File) {
    setError(null);
    const { toBase64 } = await pdf();
    const { error: e } = await supabase.rpc('save_check_asset', { p_kind: 'signature', p_account: accountId, p_base64: await toBase64(file), p_mime: file.type, p_file_name: file.name });
    if (e) return setError(e.message);
    setVersion(v => v + 1);
  }
  async function testPrint() {
    await openPdf(await checkData(s, accountId, { checkNumber: Number(s.next_check_number || 1001), date: '1/1/2027', payee: 'Sample Payee', amount: 1234.56, memo: 'Alignment test', campaign: 'Sample' }, true), 'check-test.pdf');
  }

  return (
    <div className="card">
      <h3>Check printing</h3>
      <p className="muted small">Printed on letter-size check stock with the check on top. Routing number, account number and the starting number are needed before the first check.</p>
      <div className="fields">
        <label className="field"><span>Name printed on checks</span><input value={s.print_name ?? ''} onChange={e => set('print_name', e.target.value)} placeholder="Like Cong Oizer" /></label>
        <label className="field"><span>Bank name</span><input value={s.bank_name ?? ''} onChange={e => set('bank_name', e.target.value)} placeholder="Like JP Morgan Chase" /></label>
        <label className="field"><span>Routing number</span><input inputMode="numeric" autoComplete="off" value={s.routing_number ?? ''} onChange={e => set('routing_number', e.target.value)} /></label>
        <label className="field"><span>Account number</span><input inputMode="numeric" autoComplete="off" value={s.account_number ?? ''} onChange={e => set('account_number', e.target.value)} /></label>
        <label className="field"><span>Next check number</span><input type="number" min="1" step="1" value={s.next_check_number ?? ''} onChange={e => set('next_check_number', e.target.value)} /></label>
        <label className="field"><span>Nudge right / up (mm)</span>
          <span className="inline-pair">
            <input type="number" step="0.5" aria-label="Nudge right" value={s.offset_x ?? 0} onChange={e => set('offset_x', e.target.value)} />
            <input type="number" step="0.5" aria-label="Nudge up" value={s.offset_y ?? 0} onChange={e => set('offset_y', e.target.value)} />
          </span>
        </label>
      </div>
      <label className="field"><span>Address under the name</span><textarea rows={2} value={s.print_address ?? ''} onChange={e => set('print_address', e.target.value)} /></label>
      <label className="field"><span>Signature image (PNG or JPG)</span>
        <input type="file" accept="image/png,image/jpeg" onChange={e => e.target.files?.[0] && upload(e.target.files[0])} />
        <small className="muted">{sig ? `${sig.file_name ?? 'Uploaded'} · ${dateTime(sig.updated_at)}` : 'None yet. Checks print with a blank signature line until one is added.'}</small>
      </label>
      {error && <div className="error">{error}</div>}
      {saved && <div className="notice">Saved.</div>}
      <div className="form-actions">
        <button type="button" className="btn" onClick={testPrint}>Print test page (VOID)</button>
        <div className="spacer" />
        <button type="button" className="btn primary" onClick={save}>Save check settings</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The register
// ---------------------------------------------------------------------------
function MicrFontCard() {
  const [font, setFont] = useState<Row | null>(null);
  const [transit, setTransit] = useState('A');
  const [onUs, setOnUs] = useState('C');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => { asset('micr_font').then(f => { setFont(f); if (f) { setTransit(f.transit_char ?? 'A'); setOnUs(f.onus_char ?? 'C'); } }); }, [version]);
  async function save() {
    setError(null);
    const { toBase64 } = await pdf();
    const { error: e } = file
      ? await supabase.rpc('save_check_asset', { p_kind: 'micr_font', p_account: null, p_base64: await toBase64(file), p_mime: file.type || 'font/ttf', p_file_name: file.name, p_transit_char: transit, p_onus_char: onUs })
      : await supabase.rpc('save_check_asset', { p_kind: 'micr_font', p_account: null, p_base64: bytesToBase64(fromHex((await asset('micr_font'))!.data_hex, 'MICR font file')), p_mime: font!.mime, p_file_name: font!.file_name, p_transit_char: transit, p_onus_char: onUs });
    if (e) return setError(e.message);
    setFile(null);
    setVersion(v => v + 1);
  }
  return (
    <div className="card">
      <h3>MICR font</h3>
      <p className="muted small">The bank reads the line along the bottom of each check, printed in the E-13B MICR font. Upload the font file your organization is licensed to use (TTF or OTF), and say which keys type its transit and on-us symbols. Print with MICR toner for checks the bank will process.</p>
      <div className="fields">
        <label className="field"><span>Font file</span><input type="file" accept=".ttf,.otf" onChange={e => setFile(e.target.files?.[0] ?? null)} />
          <small className="muted">{font ? `${font.file_name} · ${dateTime(font.updated_at)}` : 'None yet. Checks can\'t be printed until one is added.'}</small>
        </label>
        <label className="field"><span>Transit symbol key</span><input maxLength={1} value={transit} onChange={e => setTransit(e.target.value)} /></label>
        <label className="field"><span>On-us symbol key</span><input maxLength={1} value={onUs} onChange={e => setOnUs(e.target.value)} /></label>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="form-actions"><div className="spacer" /><button type="button" className="btn primary" disabled={!file && !font} onClick={save}>Save</button></div>
    </div>
  );
}

export function ChecksPage() {
  const [version, setVersion] = useState(0);
  const [status, setStatus] = useState('outstanding');
  const [error, setError] = useState<string | null>(null);
  const q = useQuery(
    () => fetchAll((a, b) => supabase.from('check_register').select('*').order('account_name').order('check_number', { ascending: false }).range(a, b) as never),
    [version],
  );
  const all = (q.data as Row[]) ?? [];
  const rows = all.filter(r => !status || r.status === status);
  const out = all.filter(r => r.status === 'outstanding');
  const outstanding = out.reduce((s, r) => s + Number(r.amount), 0);

  async function setTo(r: Row, to: string) {
    const reason = to === 'voided' || to === 'lost' ? prompt(`Mark check #${r.check_number} ${to}? Its number is never used again. Reason:`) : '';
    if (reason === null) return;
    setError(null);
    const { error: e } = await supabase.rpc('set_check_status', { p_check: r.id, p_status: to, p_reason: reason || null });
    if (e) return setError(e.message);
    setVersion(v => v + 1);
    window.dispatchEvent(new Event('task-sheet-changed'));
  }

  const columns: Column[] = [
    { key: 'account_name', label: 'Account' },
    { key: 'check_number', label: 'Check #', align: 'right' },
    { key: 'check_date', label: 'Date' },
    { key: 'payee', label: 'Payee', width: 180 },
    { key: 'amount', label: 'Amount', render: r => money(r.amount), align: 'right' },
    { key: 'status', label: 'Status', value: r => STATUS[r.status]?.label, render: r => <CheckPill status={r.status} /> },
    { key: 'days_outstanding', label: 'Days out', align: 'right' },
    { key: 'campaign', label: 'Campaign', campaignLink: (r: Row) => r.campaign_id, value: r => (r.campaign_id ? `${r.campaign_name ?? ''} - ${r.campaign_id}` : '') },
    { key: 'memo', label: 'Memo', long: true, optional: true },
    { key: 'status_reason', label: 'Reason', optional: true },
    { key: 'issued_by', label: 'Printed by', optional: true },
    {
      key: 'actions', label: '', render: r => (
        <RowMenu label="Check actions" items={[
          { label: 'Print again', onClick: () => { reprintCheck(r.id).catch(e => setError(friendlyError(e))); } },
          { label: 'Mark cleared', onClick: () => setTo(r, 'cleared'), hidden: r.status !== 'outstanding' },
          { label: 'Mark not cleared', onClick: () => setTo(r, 'outstanding'), hidden: r.status !== 'cleared' },
          { label: 'Mark lost', onClick: () => setTo(r, 'lost'), hidden: r.status !== 'outstanding' },
          { label: 'Void', onClick: () => setTo(r, 'voided'), hidden: r.status !== 'outstanding', danger: true },
        ]} />
      ),
    },
  ];

  return (
    <section className="view">
      {error && <div className="error">{error}</div>}
      <DataTable
        title="Check register"
        subtitle={<>Outstanding: {money(outstanding)} on {out.length} check{out.length === 1 ? '' : 's'}. Print a check from a payout: open it under <Link to="/expenses">Payouts</Link>.</>}
        rows={rows}
        loading={q.loading}
        error={q.error}
        columns={columns}
        exportName="check-register"
        actions={
          <select aria-label="Status" value={status} onChange={e => setStatus(e.target.value)}>
            <option value="">All checks</option>
            {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        }
      />
      <details className="help">
        <summary>Check printing settings (MICR font)</summary>
        <MicrFontCard />
      </details>
    </section>
  );
}
