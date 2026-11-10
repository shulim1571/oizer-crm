import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowLeftRight, CheckCheck, FileUp, Landmark, Lock, Plus, Printer, Scale, Undo2, Wand2, X } from 'lucide-react';
import Kpi from '../components/Kpi';
import { Pill } from '../components/Pill';
import { useAuth } from '../lib/auth';
import { readBankFile, guessMapping, toLines, type BankFile, type BankLine, type BankMapping } from '../lib/bankCsv';
import { dateTime, localToday, money } from '../lib/format';
import { printReport } from '../lib/printReport';
import { fetchAll, supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';
import { Overlay } from './Pledges';

// Phase 11, part 1: matching the bank's statement lines to what the books expect, and signing off each period.
// Everything here goes through database functions, which check the amounts and the locks themselves.

const DIFF_TYPES: Record<string, string> = {
  processor_fees: 'Processor fees kept back',
  bank_fee: 'Bank fee',
  interest: 'Interest',
  other: 'Something else (add a note)',
};
const ITEM_LABEL: Record<string, string> = {
  donation: 'Gift', donation_reversal: 'Refund or return', payout: 'Payout',
  bank_transfer_out: 'Transfer out', bank_transfer_in: 'Transfer in',
};
const usDate = (iso: string | null | undefined) => { if (!iso) return ''; const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number); return `${m}/${d}/${y}`; };
const cents = (n: number) => Math.round(n * 100);
const sum = (rows: Row[]) => rows.reduce((s, r) => s + cents(Number(r.amount)), 0) / 100;
const key = (r: Row) => `${r.item_type}:${r.item_id}`;
const rpc = async (name: string, args: Row) => {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message);
  return data;
};

export default function ReconciliationPage() {
  const [version, setVersion] = useState(0);
  const summary = useQuery(async () => (await rpc('bank_reconciliation_summary', {})) as Row[], [version]);
  const [account, setAccount] = useState<string>('');
  const [tab, setTab] = useState<'match' | 'lines' | 'transfers' | 'periods'>('match');
  const accounts = summary.data ?? [];
  useEffect(() => { if (!account && accounts.length) setAccount(accounts[0].account_id); }, [accounts, account]);
  const a = accounts.find(x => x.account_id === account);
  const changed = () => setVersion(v => v + 1);

  return (
    <section className="view">
      <div className="view-head">
        <div className="view-title"><h1>Bank Reconciliation</h1><span className="count">Match the bank's lines to the books, then sign off each statement</span></div>
        <div className="view-actions">
          <select value={account} onChange={e => setAccount(e.target.value)} aria-label="Bank account">
            {accounts.map(x => <option key={x.account_id} value={x.account_id}>{x.account_name}</option>)}
          </select>
        </div>
      </div>
      {summary.error && <div className="error">{summary.error}</div>}
      {!summary.loading && !accounts.length && <p className="muted">Add a bank account under Settings → Accounts first.</p>}
      {a && (
        <>
          <div className="kpis">
            <Kpi label="Lines to match" value={String(a.unmatched_lines)} icon={<Landmark size={18} />} tone={Number(a.unmatched_lines) ? 'amber' : 'green'} sub={money(a.unmatched_total)} />
            <Kpi label="Signed off through" value={a.locked_through ? usDate(a.locked_through) : 'Not yet'} icon={<Lock size={18} />} tone="blue"
              sub={a.last_statement_balance != null ? `Ending balance ${money(a.last_statement_balance)}` : undefined} />
            <Kpi label="Latest bank line" value={a.last_line_date ? usDate(a.last_line_date) : 'None yet'} icon={<FileUp size={18} />} tone="violet" small />
            <Kpi label="Outstanding checks" value={String(a.outstanding_checks)} icon={<Scale size={18} />} tone="amber" sub={money(a.outstanding_checks_total)} />
          </div>
          {/* The usual order of work: bring in the statement, match it, record moves between banks, sign off. */}
          <ol className="stepper" aria-label="Reconciliation steps">
            {([
              ['lines', 'Bank lines', a.last_line_date ? `through ${usDate(a.last_line_date)}` : 'import a statement'],
              ['match', 'Match', Number(a.unmatched_lines) ? `${a.unmatched_lines} to match` : 'all matched'],
              ['transfers', 'Between accounts', null],
              ['periods', 'Sign off', a.locked_through ? `through ${usDate(a.locked_through)}` : 'not yet'],
            ] as const).map(([t, label, cue], i) => (
              <li key={t} className={tab === t ? 'on' : ''}>
                <button type="button" onClick={() => setTab(t)} aria-current={tab === t ? 'step' : undefined}>
                  <span>{i + 1}</span>{label}{cue && <small className="step-cue">{cue}</small>}
                </button>
              </li>
            ))}
          </ol>
          {tab === 'match' && <MatchTab account={account} version={version} onChanged={changed} />}
          {tab === 'lines' && <LinesTab account={account} version={version} onChanged={changed} />}
          {tab === 'transfers' && <TransfersTab accounts={accounts} version={version} onChanged={changed} />}
          {tab === 'periods' && <PeriodsTab account={account} accountName={a.account_name} version={version} onChanged={changed} />}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Matching: bank lines on the left, book items on the right
// ---------------------------------------------------------------------------
function MatchTab({ account, version, onChanged }: { account: string; version: number; onChanged: () => void }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [search, setSearch] = useState('');
  const [pickedLines, setPickedLines] = useState<Set<string>>(new Set());
  const [pickedItems, setPickedItems] = useState<Set<string>>(new Set());
  const [diffType, setDiffType] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showMatched, setShowMatched] = useState(false);

  const lines = useQuery(() => fetchAll((a, b) => supabase.from('bank_lines').select('*').eq('account_id', account).is('match_id', null)
    .order('posted_date').order('id').range(a, b) as never), [account, version]);
  const book = useQuery(async () => (await rpc('bank_book_items', { p_account: account })) as Row[], [account, version]);
  useEffect(() => { setPickedLines(new Set()); setPickedItems(new Set()); setDiffType(''); setNote(''); }, [account, version]);

  const inRange = (d: string) => (!from || d >= from) && (!to || d <= to);
  const matches = (r: Row) => !search || `${r.description ?? ''} ${r.check_number ?? ''} ${r.amount}`.toLowerCase().includes(search.toLowerCase());
  const openLines = (lines.data ?? []).filter(l => inRange(l.posted_date) && matches(l));
  const openItems = (book.data ?? []).filter(b => !b.match_id && !b.excluded && inRange(String(b.item_date)) && matches(b));
  const setAside = (book.data ?? []).filter(b => b.excluded);

  const chosenLines = (lines.data ?? []).filter(l => pickedLines.has(l.id));
  const chosenItems = (book.data ?? []).filter(b => pickedItems.has(key(b)));
  const bankTotal = sum(chosenLines);
  const bookTotal = sum(chosenItems);
  const diff = Math.round((bankTotal - bookTotal) * 100) / 100;

  const toggle = (set: Set<string>, k: string, apply: (s: Set<string>) => void) => {
    const n = new Set(set);
    if (n.has(k)) n.delete(k); else n.add(k);
    apply(n);
  };

  async function run(fn: () => Promise<unknown>, done?: string) {
    setBusy(true); setError(null); setMessage(null);
    try { await fn(); if (done) setMessage(done); onChanged(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    setBusy(false);
  }
  const match = () => run(() => rpc('match_bank', {
    p_account: account, p_lines: [...pickedLines],
    p_items: chosenItems.map(b => ({ type: b.item_type, id: b.item_id })),
    p_difference_type: diff !== 0 ? diffType || null : null, p_note: note || null,
  }), 'Matched.');
  const autoMatch = () => run(async () => {
    const n = (await rpc('auto_match_bank', { p_account: account })) as number;
    setMessage(n ? `Matched ${n} automatically. Check the rest by hand.` : 'Nothing could be matched with certainty. Match the rest by hand.');
  });
  const exclude = (b: Row) => {
    const reason = prompt(`Set aside "${b.description}" (${money(b.amount)})? It never passes through this bank, for example an opening balance. Give a reason:`);
    if (reason) void run(() => rpc('exclude_book_item', { p_type: b.item_type, p_id: b.item_id, p_reason: reason }));
  };

  return (
    <>
      <div className="filters">
        <label className="field inline"><span>From</span><input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label>
        <label className="field inline"><span>To</span><input type="date" value={to} onChange={e => setTo(e.target.value)} /></label>
        <input placeholder="Search description, check # or amount" value={search} onChange={e => setSearch(e.target.value)} />
        <div className="spacer" />
        <button type="button" className="btn" onClick={() => setShowMatched(true)}>Matched</button>
        <button type="button" className="btn primary" disabled={busy} onClick={autoMatch}><Wand2 size={16} /> Match automatically</button>
      </div>
      {message && <p className="muted">{message}</p>}
      {(lines.error || book.error) && <div className="error">{lines.error || book.error}</div>}

      <div className="recon-grid">
        <PickTable
          title={`Bank lines (${openLines.length})`}
          rows={openLines} rowKey={l => l.id} picked={pickedLines}
          onToggle={l => toggle(pickedLines, l.id, setPickedLines)}
          cells={l => [usDate(l.posted_date), <>{l.description}{l.check_number && <span className="muted"> · #{l.check_number}</span>}</>]}
          empty={lines.loading ? 'Loading…' : 'Every bank line is matched. Bring in more on the Bank lines tab.'}
        />
        <PickTable
          title={`Books (${openItems.length})`}
          rows={openItems} rowKey={key} picked={pickedItems}
          onToggle={b => toggle(pickedItems, key(b), setPickedItems)}
          cells={b => [usDate(String(b.item_date)), <>
            <Pill tone={b.amount < 0 ? 'amber' : 'green'}>{ITEM_LABEL[b.item_type]}</Pill> {b.description}
            {b.check_number && <span className="muted"> · #{b.check_number}</span>}
            {b.campaign_id && <span className="muted"> · {b.campaign_id}</span>}
          </>]}
          action={b => <button type="button" className="link small" title="Never passes through this bank" onClick={() => exclude(b)}>Set aside</button>}
          empty={book.loading ? 'Loading…' : 'Nothing in the books is waiting for the bank.'}
        />
      </div>

      <div className="recon-foot">
        <span>Bank <b>{money(bankTotal)}</b> ({chosenLines.length})</span>
        <span>Books <b>{money(bookTotal)}</b> ({chosenItems.length})</span>
        <span className={diff === 0 ? 'pos' : 'neg'}>Difference <b>{money(diff)}</b></span>
        {diff !== 0 && chosenLines.length > 0 && (
          <>
            <select value={diffType} onChange={e => setDiffType(e.target.value)} aria-label="What the difference is">
              <option value="">What is the difference?</option>
              {Object.entries(DIFF_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <input placeholder={diffType === 'other' ? 'Note (required)' : 'Note'} value={note} onChange={e => setNote(e.target.value)} />
          </>
        )}
        <div className="spacer" />
        <button type="button" className="btn primary" disabled={busy || !chosenLines.length || (diff !== 0 && !diffType)} onClick={match}>
          <CheckCheck size={16} /> Match
        </button>
      </div>
      {error && <div className="error">{error}</div>}

      {setAside.length > 0 && (
        <details>
          <summary className="muted">{setAside.length} set aside, not expected in this bank</summary>
          <ul className="plain-list">
            {setAside.map(b => (
              <li key={key(b)}>{usDate(String(b.item_date))} · {b.description} · {money(b.amount)} <span className="muted">({b.exclude_reason})</span>{' '}
                <button type="button" className="link small" onClick={() => run(() => rpc('include_book_item', { p_type: b.item_type, p_id: b.item_id }))}>Put back</button>
              </li>
            ))}
          </ul>
        </details>
      )}
      {showMatched && <MatchedDialog account={account} onClose={() => setShowMatched(false)} onChanged={onChanged} />}
    </>
  );
}

function PickTable({ title, rows, rowKey, picked, onToggle, cells, action, empty }: {
  title: string; rows: Row[]; rowKey: (r: Row) => string; picked: Set<string>; onToggle: (r: Row) => void;
  cells: (r: Row) => ReactNode[]; action?: (r: Row) => ReactNode; empty: string;
}) {
  return (
    <div className="table-card recon-table">
      <div className="recon-title">{title}</div>
      <div className="table-wrap">
        <table className="grid">
          <thead><tr><th className="pick nosort" /><th className="nosort">Date</th><th className="nosort">Details</th><th className="nosort right">Amount</th>{action && <th className="nosort" />}</tr></thead>
          <tbody>
            {rows.map(r => {
              const [date, details] = cells(r);
              return (
                <tr key={rowKey(r)} className={`clickable${picked.has(rowKey(r)) ? ' picked' : ''}`} onClick={() => onToggle(r)}>
                  <td className="pick"><input type="checkbox" checked={picked.has(rowKey(r))} onChange={() => onToggle(r)} onClick={e => e.stopPropagation()} aria-label="Choose" /></td>
                  <td>{date}</td>
                  <td>{details}</td>
                  <td className={`right ${Number(r.amount) < 0 ? 'neg' : 'pos'}`}>{money(r.amount)}</td>
                  {action && <td onClick={e => e.stopPropagation()}>{action(r)}</td>}
                </tr>
              );
            })}
            {!rows.length && <tr><td colSpan={action ? 5 : 4} className="muted">{empty}</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MatchedDialog({ account, onClose, onChanged }: { account: string; onClose: () => void; onChanged: () => void }) {
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const q = useQuery(async () => {
    const { data: m, error: e } = await supabase.from('recon_matches').select('*').eq('account_id', account).order('created_at', { ascending: false }).limit(200);
    if (e) throw new Error(e.message);
    const ids = (m ?? []).map(x => x.id);
    if (!ids.length) return [];
    const [{ data: l }, { data: i }] = await Promise.all([
      supabase.from('bank_lines').select('match_id, posted_date, description, amount').in('match_id', ids),
      supabase.from('recon_match_items').select('match_id, item_type, amount').in('match_id', ids),
    ]);
    return (m ?? []).map(x => ({ ...x, lines: (l ?? []).filter(y => y.match_id === x.id), items: (i ?? []).filter(y => y.match_id === x.id) }));
  }, [account, version]);
  const unmatch = async (id: string) => {
    setError(null);
    const { error: e } = await supabase.rpc('unmatch_bank', { p_match: id });
    if (e) return setError(e.message);
    setVersion(v => v + 1);
    onChanged();
  };
  return (
    <Overlay onClose={onClose}>
      <div className="form-head"><h2>Matched (latest 200)</h2><button type="button" className="icon-btn" title="Close" onClick={onClose}><X size={18} /></button></div>
      {error && <div className="error">{error}</div>}
      <div className="table-wrap dialog-table"><table className="grid">
        <thead><tr><th className="nosort">Bank</th><th className="nosort">Books</th><th className="nosort right">Difference</th><th className="nosort">By</th><th className="nosort" /></tr></thead>
        <tbody>
          {(q.data ?? []).map(m => (
            <tr key={m.id}>
              <td>{m.lines.map((l: Row, n: number) => <div key={n}>{usDate(l.posted_date)} · {l.description} · {money(l.amount)}</div>)}</td>
              <td>{m.items.length ? `${m.items.length} item${m.items.length > 1 ? 's' : ''} · ${money(m.items_total)}` : <span className="muted">Bank only</span>}</td>
              <td className="right">{Number(m.difference) !== 0 && <>{money(m.difference)}<div className="muted small">{DIFF_TYPES[m.difference_type]?.replace(' (add a note)', '')}{m.note ? `: ${m.note}` : ''}</div></>}</td>
              <td className="small">{m.kind === 'auto' ? 'Automatic' : m.created_by}<div className="muted">{dateTime(m.created_at)}</div></td>
              <td><button type="button" className="link" onClick={() => unmatch(m.id)}><Undo2 size={13} /> Unmatch</button></td>
            </tr>
          ))}
          {!q.loading && !(q.data ?? []).length && <tr><td colSpan={5} className="muted">Nothing matched yet.</td></tr>}
        </tbody>
      </table></div>
    </Overlay>
  );
}

// ---------------------------------------------------------------------------
// Bank lines: bring in a statement file, or type a line
// ---------------------------------------------------------------------------
function LinesTab({ account, version, onChanged }: { account: string; version: number; onChanged: () => void }) {
  const [importing, setImporting] = useState<{ file: BankFile; name: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const lines = useQuery(() => fetchAll((a, b) => supabase.from('bank_lines').select('*').eq('account_id', account)
    .order('posted_date', { ascending: false }).order('id').range(a, b) as never), [account, version]);
  const imports = useQuery(async () => (await supabase.from('bank_imports').select('*').eq('account_id', account).order('created_at', { ascending: false }).limit(20)).data ?? [], [account, version]);

  async function pick(file: File) {
    setError(null); setMessage(null);
    try { setImporting({ file: await readBankFile(file), name: file.name }); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  async function act(name: string, args: Row, confirmText?: string) {
    if (confirmText && !confirm(confirmText)) return;
    setError(null);
    try { await rpc(name, args); onChanged(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  return (
    <>
      <div className="filters">
        <label className="btn primary"><FileUp size={16} /> Bring in a statement file (CSV or Excel)
          <input type="file" accept=".csv,.xlsx,text/csv" hidden onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void pick(f); }} />
        </label>
        <button type="button" className="btn" onClick={() => setAdding(true)}><Plus size={16} /> Type a line</button>
      </div>
      <p className="muted small">Download the statement or activity from the bank's website. A file brought in twice, or two statements that overlap, only adds the lines that are new.</p>
      {message && <p className="muted">{message}</p>}
      {error && <div className="error">{error}</div>}

      {(imports.data ?? []).length > 0 && (
        <div className="table-card"><div className="table-wrap"><table className="grid">
          <thead><tr><th className="nosort">File</th><th className="nosort right">Added</th><th className="nosort right">Already in</th><th className="nosort">By</th><th className="nosort" /></tr></thead>
          <tbody>
            {(imports.data ?? []).map(i => (
              <tr key={i.id}>
                <td>{i.file_name ?? 'File'}{i.undone_at && <> <Pill>Undone</Pill></>}</td>
                <td className="right">{i.added}</td><td className="right">{i.skipped}</td>
                <td className="small">{i.created_by} <span className="muted">{dateTime(i.created_at)}</span></td>
                <td>{!i.undone_at && <button type="button" className="link" onClick={() => act('undo_bank_import', { p_import: i.id }, `Take back the ${i.added} lines this file added?`)}><Undo2 size={13} /> Undo</button>}</td>
              </tr>
            ))}
          </tbody>
        </table></div></div>
      )}

      <div className="table-card"><div className="table-wrap"><table className="grid">
        <thead><tr><th className="nosort">Date</th><th className="nosort">Description</th><th className="nosort">Check #</th><th className="nosort right">Amount</th><th className="nosort">Status</th><th className="nosort" /></tr></thead>
        <tbody>
          {(lines.data ?? []).map(l => (
            <tr key={l.id}>
              <td>{usDate(l.posted_date)}</td><td>{l.description}</td><td>{l.check_number}</td>
              <td className={`right ${l.amount < 0 ? 'neg' : 'pos'}`}>{money(l.amount)}</td>
              <td>{l.match_id ? <Pill tone="green">Matched</Pill> : <Pill tone="amber">To match</Pill>}{l.source === 'manual' && <> <Pill>Typed</Pill></>}</td>
              <td>{!l.match_id && <button type="button" className="link small" onClick={() => act('delete_bank_line', { p_line: l.id }, 'Delete this bank line?')}>Delete</button>}</td>
            </tr>
          ))}
          {!lines.loading && !(lines.data ?? []).length && <tr><td colSpan={6} className="muted">No bank lines yet.</td></tr>}
        </tbody>
      </table></div></div>

      {importing && <ImportDialog account={account} file={importing.file} name={importing.name} onClose={() => setImporting(null)}
        onDone={m => { setImporting(null); setMessage(m); onChanged(); }} />}
      {adding && <AddLineDialog account={account} onClose={() => setAdding(false)} onDone={() => { setAdding(false); onChanged(); }} />}
    </>
  );
}

function ImportDialog({ account, file, name, onClose, onDone }: { account: string; file: BankFile; name: string; onClose: () => void; onDone: (message: string) => void }) {
  const [map, setMap] = useState<BankMapping>(() => guessMapping(file.headers));
  const [twoColumns, setTwoColumns] = useState(map.amount === null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const result = useMemo(() => toLines(file, twoColumns ? { ...map, amount: null } : { ...map, debit: null, credit: null }), [file, map, twoColumns]);
  const ready = map.date !== null && (twoColumns ? map.debit !== null || map.credit !== null : map.amount !== null);
  const totalIn = result.lines.filter(l => l.amount > 0).reduce((s, l) => s + l.amount, 0);
  const totalOut = result.lines.filter(l => l.amount < 0).reduce((s, l) => s + l.amount, 0);

  const column = (label: string, k: keyof BankMapping, optional = true) => (
    <label className="field"><span>{label}</span>
      <select value={map[k] === null ? '' : String(map[k])} onChange={e => setMap(m => ({ ...m, [k]: e.target.value === '' ? null : Number(e.target.value) }))}>
        {optional && <option value="">None</option>}
        {file.headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
      </select>
    </label>
  );

  async function save() {
    setBusy(true); setError(null);
    try {
      const [r] = (await rpc('import_bank_lines', { p_account: account, p_file_name: name, p_lines: result.lines as BankLine[] })) as Row[];
      onDone(`Added ${r.added} line${r.added === 1 ? '' : 's'}.`
        + (r.skipped_duplicate ? ` ${r.skipped_duplicate} were already in.` : '')
        + (r.skipped_locked ? ` ${r.skipped_locked} fall in a signed-off period and were left out.` : ''));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
  }

  return (
    <Overlay onClose={onClose}>
      <div className="form-head"><h2>Bring in {name}</h2><button type="button" className="icon-btn" title="Close" onClick={onClose}><X size={18} /></button></div>
      <p className="muted small">Check which column is which. Money coming in should show as positive.</p>
      <div className="fields">
        {column('Date', 'date', false)}
        {column('Description', 'description')}
        <label className="field"><span>Amounts are in</span>
          <select value={twoColumns ? 'two' : 'one'} onChange={e => setTwoColumns(e.target.value === 'two')}>
            <option value="one">One column</option><option value="two">Separate debit and credit columns</option>
          </select>
        </label>
        {twoColumns ? <>{column('Debit (money out)', 'debit')}{column('Credit (money in)', 'credit')}</> : column('Amount', 'amount', false)}
        {column('Check number', 'checkNumber')}
        {column('Bank reference', 'reference')}
      </div>
      {!twoColumns && (
        <label className="check-row"><input type="checkbox" checked={map.flipSign} onChange={e => setMap(m => ({ ...m, flipSign: e.target.checked }))} /> This bank shows money going out as positive</label>
      )}
      <p><b>{result.lines.length}</b> lines · in {money(totalIn)} · out {money(totalOut)}{result.skippedZero ? ` · ${result.skippedZero} zero lines left out` : ''}</p>
      {result.problems.length > 0 && <div className="error">{result.problems.slice(0, 5).join('; ')}{result.problems.length > 5 ? `; and ${result.problems.length - 5} more` : ''}. Those rows will be left out.</div>}
      <div className="table-wrap dialog-table"><table className="grid">
        <thead><tr><th className="nosort">Date</th><th className="nosort">Description</th><th className="nosort">Check #</th><th className="nosort right">Amount</th></tr></thead>
        <tbody>{result.lines.slice(0, 8).map((l, i) => <tr key={i}><td>{usDate(l.date)}</td><td>{l.description}</td><td>{l.check_number}</td><td className={`right ${l.amount < 0 ? 'neg' : 'pos'}`}>{money(l.amount)}</td></tr>)}</tbody>
      </table></div>
      {error && <div className="error">{error}</div>}
      <div className="form-actions">
        <div className="spacer" />
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={busy || !ready || !result.lines.length} onClick={save}>Add {result.lines.length} lines</button>
      </div>
    </Overlay>
  );
}

function AddLineDialog({ account, onClose, onDone }: { account: string; onClose: () => void; onDone: () => void }) {
  const [date, setDate] = useState(localToday());
  const [direction, setDirection] = useState<'in' | 'out'>('in');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [check, setCheck] = useState('');
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setError(null);
    const n = Math.abs(Number(amount));
    try {
      await rpc('add_bank_line', { p_account: account, p_date: date, p_amount: direction === 'out' ? -n : n, p_description: description || null, p_check_number: check || null });
      onDone();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  return (
    <Overlay onClose={onClose}>
      <div className="form-head"><h2>Type a bank line</h2><button type="button" className="icon-btn" title="Close" onClick={onClose}><X size={18} /></button></div>
      <div className="fields">
        <label className="field"><span>Date</span><input type="date" value={date} onChange={e => setDate(e.target.value)} /></label>
        <label className="field"><span>Money</span><select value={direction} onChange={e => setDirection(e.target.value as 'in' | 'out')}><option value="in">In (deposit)</option><option value="out">Out (withdrawal)</option></select></label>
        <label className="field"><span>Amount</span><input inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} /></label>
        <label className="field"><span>Description</span><input value={description} onChange={e => setDescription(e.target.value)} /></label>
        <label className="field"><span>Check number</span><input inputMode="numeric" value={check} onChange={e => setCheck(e.target.value)} /></label>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="form-actions"><div className="spacer" /><button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={!Number(amount)} onClick={save}>Add line</button></div>
    </Overlay>
  );
}

// ---------------------------------------------------------------------------
// Money moved between the organization's own bank accounts
// ---------------------------------------------------------------------------
function TransfersTab({ accounts, version, onChanged }: { accounts: Row[]; version: number; onChanged: () => void }) {
  const [start, setStart] = useState<Row | null>(null);
  const [error, setError] = useState<string | null>(null);
  const needed = useQuery(async () => (await supabase.from('bank_moves_needed').select('*').order('created_at')).data ?? [], [version]);
  const done = useQuery(async () => (await supabase.from('bank_transfers').select('*').is('deleted_at', null).order('transfer_date', { ascending: false }).limit(200)).data ?? [], [version]);
  const name = (id: string | null) => accounts.find(a => a.account_id === id)?.account_name ?? id ?? 'No account';
  async function remove(t: Row) {
    const reason = prompt('Delete this bank transfer? Give a reason:');
    if (!reason) return;
    setError(null);
    const { error: e } = await supabase.rpc('delete_bank_transfer', { p_id: t.id, p_reason: reason });
    if (e) return setError(e.message);
    onChanged();
  }
  return (
    <>
      <div className="filters"><button type="button" className="btn primary" onClick={() => setStart({})}><ArrowLeftRight size={16} /> Record a transfer between accounts</button></div>
      {error && <div className="error">{error}</div>}
      {(needed.data ?? []).length > 0 && (
        <div className="table-card">
          <div className="recon-title">Waiting to move: cross-account campaign transfers</div>
          <div className="table-wrap"><table className="grid">
            <thead><tr><th className="nosort">Campaigns</th><th className="nosort">From bank</th><th className="nosort">To bank</th><th className="nosort right">Amount</th><th className="nosort" /></tr></thead>
            <tbody>
              {(needed.data ?? []).map(n => (
                <tr key={n.transfer_id}>
                  <td>{n.from_campaign_id} → {n.to_campaign_id}<div className="muted small">{dateTime(n.created_at)}</div></td>
                  <td>{name(n.from_account)}</td><td>{name(n.to_account)}</td><td className="right">{money(n.amount)}</td>
                  <td><button type="button" className="btn" onClick={() => setStart({ from: n.from_account, to: n.to_account, amount: n.amount, campaignTransfer: n.transfer_id, memo: `Campaign ${n.from_campaign_id} → ${n.to_campaign_id}` })}>Record it</button></td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </div>
      )}
      <div className="table-card"><div className="table-wrap"><table className="grid">
        <thead><tr><th className="nosort">Date</th><th className="nosort">From</th><th className="nosort">To</th><th className="nosort right">Amount</th><th className="nosort">Memo</th><th className="nosort" /></tr></thead>
        <tbody>
          {(done.data ?? []).map(t => (
            <tr key={t.id}>
              <td>{usDate(t.transfer_date)}</td><td>{name(t.from_account)}</td><td>{name(t.to_account)}</td><td className="right">{money(t.amount)}</td>
              <td>{t.memo}{t.campaign_transfer_id && <> <Pill tone="blue">For a campaign transfer</Pill></>}</td>
              <td><button type="button" className="link small" onClick={() => remove(t)}>Delete</button></td>
            </tr>
          ))}
          {!done.loading && !(done.data ?? []).length && <tr><td colSpan={6} className="muted">No transfers between accounts yet.</td></tr>}
        </tbody>
      </table></div></div>
      {start && <BankTransferDialog accounts={accounts} start={start} onClose={() => setStart(null)} onDone={() => { setStart(null); onChanged(); }} />}
    </>
  );
}

function BankTransferDialog({ accounts, start, onClose, onDone }: { accounts: Row[]; start: Row; onClose: () => void; onDone: () => void }) {
  const [from, setFrom] = useState<string>(start.from ?? '');
  const [to, setTo] = useState<string>(start.to ?? '');
  const [amount, setAmount] = useState(start.amount ? String(start.amount) : '');
  const [date, setDate] = useState(localToday());
  const [memo, setMemo] = useState<string>(start.memo ?? '');
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setError(null);
    try {
      await rpc('record_bank_transfer', { p_from: from, p_to: to, p_amount: Number(amount), p_date: date, p_memo: memo || null, p_campaign_transfer: start.campaignTransfer ?? null });
      onDone();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  const pick = (value: string, set: (v: string) => void, label: string) => (
    <label className="field"><span>{label}</span><select value={value} onChange={e => set(e.target.value)} disabled={!!start.campaignTransfer && !!value}>
      <option value="">Choose…</option>{accounts.map(a => <option key={a.account_id} value={a.account_id}>{a.account_name}</option>)}
    </select></label>
  );
  return (
    <Overlay onClose={onClose}>
      <div className="form-head"><h2>Transfer between bank accounts</h2><button type="button" className="icon-btn" title="Close" onClick={onClose}><X size={18} /></button></div>
      <p className="muted small">Record money the bank moved between the organization's own accounts. Campaign balances don't change.</p>
      <div className="fields">
        {pick(from, setFrom, 'From')}{pick(to, setTo, 'To')}
        <label className="field"><span>Amount</span><input inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} disabled={!!start.campaignTransfer} /></label>
        <label className="field"><span>Date</span><input type="date" value={date} onChange={e => setDate(e.target.value)} /></label>
        <label className="field"><span>Memo</span><input value={memo} onChange={e => setMemo(e.target.value)} /></label>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="form-actions"><div className="spacer" /><button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={!from || !to || !Number(amount)} onClick={save}>Record transfer</button></div>
    </Overlay>
  );
}

// ---------------------------------------------------------------------------
// Periods: sign off against the statement, print the reconciliation, reopen
// ---------------------------------------------------------------------------
function PeriodsTab({ account, accountName, version, onChanged }: { account: string; accountName: string; version: number; onChanged: () => void }) {
  const { isSuperAdmin } = useAuth();
  const periods = useQuery(async () => (await supabase.from('bank_periods').select('*').eq('account_id', account).order('period_end', { ascending: false })).data ?? [], [account, version]);
  const last = (periods.data ?? []).find(p => p.status === 'signed');
  const [end, setEnd] = useState('');
  const [balance, setBalance] = useState('');
  const [opening, setOpening] = useState('');
  const [startDate, setStartDate] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function signOff() {
    setError(null);
    try {
      await rpc('sign_off_bank_period', {
        p_account: account, p_period_end: end, p_statement_balance: Number(balance),
        p_opening_balance: last ? null : Number(opening), p_period_start: last ? null : startDate, p_note: note || null,
      });
      setEnd(''); setBalance(''); setOpening(''); setStartDate(''); setNote('');
      onChanged();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  async function reopen(p: Row) {
    const reason = prompt(`Reopen the period ending ${usDate(p.period_end)}? Its matches can change again. Give a reason:`);
    if (!reason) return;
    setError(null);
    try { await rpc('reopen_bank_period', { p_period: p.id, p_reason: reason }); onChanged(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  return (
    <>
      <div className="table-card recon-signoff">
        <div className="recon-title">Sign off a statement</div>
        <p className="muted small">
          {last ? `The next period starts ${usDate(nextDay(last.period_end))}, with last period's ending balance of ${money(last.statement_balance)}.`
            : 'For the first statement, enter its start date and opening balance.'}
          {' '}Every bank line up to the end date has to be matched or explained, and the lines have to add up to the statement's ending balance.
        </p>
        <div className="fields">
          {!last && <>
            <label className="field"><span>Statement start</span><input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} /></label>
            <label className="field"><span>Opening balance</span><input inputMode="decimal" value={opening} onChange={e => setOpening(e.target.value)} /></label>
          </>}
          <label className="field"><span>Statement end</span><input type="date" value={end} onChange={e => setEnd(e.target.value)} /></label>
          <label className="field"><span>Ending balance</span><input inputMode="decimal" value={balance} onChange={e => setBalance(e.target.value)} /></label>
          <label className="field"><span>Note</span><input value={note} onChange={e => setNote(e.target.value)} /></label>
        </div>
        {error && <div className="error">{error}</div>}
        <div className="form-actions"><div className="spacer" />
          <button type="button" className="btn primary" disabled={!end || balance === '' || (!last && (!startDate || opening === ''))} onClick={signOff}><Lock size={16} /> Sign off</button>
        </div>
      </div>

      <div className="table-card"><div className="table-wrap"><table className="grid">
        <thead><tr><th className="nosort">Period</th><th className="nosort right">Opening</th><th className="nosort right">Ending</th><th className="nosort right">In transit</th><th className="nosort right">Outstanding</th><th className="nosort">Signed off</th><th className="nosort" /></tr></thead>
        <tbody>
          {(periods.data ?? []).map(p => (
            <tr key={p.id}>
              <td>{usDate(p.period_start)} – {usDate(p.period_end)}{p.status === 'reopened' && <> <Pill tone="amber">Reopened</Pill></>}</td>
              <td className="right">{money(p.opening_balance)}</td><td className="right">{money(p.statement_balance)}</td>
              <td className="right">{money(p.report.deposits_in_transit)}</td><td className="right">{money(p.report.outstanding_payments)}</td>
              <td className="small">{p.signed_by} <span className="muted">{dateTime(p.signed_at)}</span>
                {p.status === 'reopened' && <div className="muted">Reopened by {p.reopened_by}: {p.reopen_reason}</div>}</td>
              <td>
                <button type="button" className="link" onClick={() => printPeriod(p, accountName).catch(e => alert(e.message))}><Printer size={13} /> Print</button>
                {isSuperAdmin && p.id === last?.id && <> · <button type="button" className="link" onClick={() => reopen(p)}>Reopen</button></>}
              </td>
            </tr>
          ))}
          {!periods.loading && !(periods.data ?? []).length && <tr><td colSpan={7} className="muted">No periods signed off yet.</td></tr>}
        </tbody>
      </table></div></div>
    </>
  );
}

const nextDay = (iso: string) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };

/** The bank reconciliation as signed off: statement to adjusted balance, and what was still outstanding. */
function printPeriod(p: Row, accountName: string) {
  const r = p.report as Row;
  const diffRows = (r.differences as Row[]).map(d => ({ kind: DIFF_TYPES[d.type]?.replace(' (add a note)', '') ?? d.type, count: d.count, total: money(d.total) }));
  return printReport(`Bank reconciliation: ${accountName}`, [
    { key: 'date', label: 'Date' }, { key: 'kind', label: 'Kind' }, { key: 'description', label: 'Details' },
    { key: 'check', label: 'Check #' }, { key: 'amount', label: 'Amount', align: 'right' },
  ], (r.outstanding as Row[]).map(o => ({ date: usDate(o.item_date), kind: ITEM_LABEL[o.item_type] ?? o.item_type, description: o.description, check: o.check_number ?? '', amount: money(o.amount) })), {
    subtitle: `${usDate(p.period_start)} to ${usDate(p.period_end)} · signed off by ${p.signed_by} ${dateTime(p.signed_at)}${p.status === 'reopened' ? ' · REOPENED' : ''}`,
    summary: [
      ['Opening balance', money(p.opening_balance)],
      ['Deposits', money(r.deposits)],
      ['Withdrawals', money(r.withdrawals)],
      ['Statement ending balance', money(p.statement_balance)],
      ['Add deposits in transit', money(r.deposits_in_transit)],
      ['Less outstanding payments', money(r.outstanding_payments)],
      ['Adjusted bank balance', money(r.adjusted_balance)],
      ['Bank lines', String(r.line_count)],
      ...(p.note ? [['Note', p.note] as [string, string]] : []),
    ],
    before: diffRows.length ? [{ title: 'Differences explained', columns: [{ key: 'kind', label: 'Kind' }, { key: 'count', label: 'Matches', align: 'right' }, { key: 'total', label: 'Total', align: 'right' }], rows: diffRows }] : [],
  });
}
