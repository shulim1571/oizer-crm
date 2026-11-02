import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, Upload, X } from 'lucide-react';
import DataTable from '../components/DataTable';
import { Pill } from '../components/Pill';
import { useAuth } from '../lib/auth';
import { dateTime, download, toCsv } from '../lib/format';
import { clearLookups } from '../lib/lookups';
import { XLSX_TYPE, downloadBytes, readSheet, toXlsx } from '../lib/sheets';
import { fetchAll, supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';
import { Overlay } from './Pledges';

type Kind = 'campaigns' | 'donors' | 'donations' | 'pledges' | 'fundraisers' | 'contacts';

// Template columns, with the required ones first. Headers are matched loosely, so "First Name" and "first_name" both work.
const TEMPLATES: Record<Kind, { label: string; columns: string[]; required: string; sample: string[]; duplicates?: string[] }> = {
  campaigns: {
    label: 'Campaigns', columns: ['Campaign ID', 'Internal Name', 'External Name', 'Fundraiser', 'Goal', 'Status', 'Parent ID', 'Opening Balance', 'Notes'],
    required: 'Campaign ID, Internal Name and External Name', sample: ['1042', 'Building fund', 'Building Fund 2026', 'Moshe Cohen', '50000', 'Active', '', '12500', ''],
    duplicates: ['skip', 'overwrite'],
  },
  donors: {
    label: 'Donors', columns: ['First Name', 'Last Name', 'Email', 'Phone', 'Address', 'City', 'State', 'Postal Code', 'Country', 'Notes'],
    required: 'First Name and Last Name', sample: ['Chaim', 'Gold', 'chaim@example.com', '845-555-0100', '5 Main St', 'Monsey', 'NY', '10952', 'US', ''],
    duplicates: ['skip', 'merge', 'new'],
  },
  donations: {
    label: 'Donation history', columns: ['Donor ID', 'Donor Name', 'Campaign ID', 'Campaign Name', 'Amount', 'Date', 'Payment Method', 'Notes', 'Receipt Sent'],
    required: 'Donor ID or Name, Campaign ID or Name, Amount and Date', sample: ['', 'Chaim Gold', '1042', '', '180', '3/15/2025', 'Check', '', 'Y'],
  },
  pledges: {
    label: 'Pledges', columns: ['Donor ID', 'Donor Name', 'Campaign ID', 'Campaign Name', 'Pledge Amount', 'Date Pledged', 'Expected Date', 'Notes', 'Status'],
    required: 'Donor ID or Name, Campaign ID or Name, Pledge Amount and Date Pledged', sample: ['', 'Chaim Gold', '1042', '', '1800', '1/5/2026', '12/1/2026', '', 'Open'],
  },
  fundraisers: {
    label: 'Fundraisers', columns: ['First Name', 'Last Name', 'Phone', 'Email'],
    required: 'First Name and Last Name', sample: ['Moshe', 'Cohen', '718-555-0199', 'moshe@example.com'],
  },
  contacts: {
    label: 'Contact list', columns: ['First Name', 'Last Name', 'Phone', 'Email', 'Address', 'City', 'State', 'Postal Code', 'Country', 'Notes'],
    required: 'a name', sample: ['Chaim', 'Gold', '845-555-0100', '', '', '', '', '', '', 'Met at the dinner'],
  },
};
const DUP_LABEL: Record<string, string> = { skip: 'Skip them', merge: 'Fill in blanks on the existing record', new: 'Add them as new', overwrite: 'Overwrite the existing campaign' };
const STATUS_TONE: Record<string, 'green' | 'blue' | 'amber' | 'red' | ''> = { created: 'green', linked: 'blue', updated: 'blue', skipped: 'amber', error: 'red' };

function downloadTemplate(kind: Kind, format: 'csv' | 'xlsx') {
  const t = TEMPLATES[kind];
  const cols = t.columns.map(c => ({ key: c, label: c }));
  const row = Object.fromEntries(t.columns.map((c, i) => [c, t.sample[i] ?? '']));
  if (format === 'csv') download(`${kind}-template.csv`, toCsv([row], cols));
  else downloadBytes(`${kind}-template.xlsx`, toXlsx([row], cols, t.label), XLSX_TYPE);
}

/** Pick a file, preview every row, then commit. */
function Importer({ kind, campaign, onDone }: { kind: Kind; campaign?: string; onDone: () => void }) {
  const t = TEMPLATES[kind];
  const [file, setFile] = useState<File | null>(null);
  const [rows, setRows] = useState<Record<string, string>[] | null>(null);
  const [dup, setDup] = useState(t.duplicates?.[0] ?? 'skip');
  const [result, setResult] = useState<Row | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = { duplicates: dup, ...(campaign ? { campaign } : {}) };

  async function pick(f: File | undefined) {
    setError(null);
    setResult(null);
    setRows(null);
    if (!f) return;
    if (f.size > 10 * 1024 * 1024) return setError('Files can be up to 10 MB. Split it into smaller files.');
    if (!/\.(csv|xlsx)$/i.test(f.name)) return setError('Upload a .csv or .xlsx file.');
    setFile(f);
    try {
      const data = await readSheet(f);
      if (!data.length) return setError('That file has a header row but nothing under it.');
      setRows(data);
      await go(data, false, f);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  async function go(data: Record<string, string>[], commit: boolean, f = file) {
    setBusy(true);
    setError(null);
    const { data: r, error: e } = await supabase.rpc('run_import', { p_kind: kind, p_file_name: f?.name ?? null, p_rows: data, p_options: options, p_commit: commit });
    setBusy(false);
    if (e) return setError(e.message);
    setResult(r as Row);
    if (commit) { clearLookups(); window.dispatchEvent(new Event('task-sheet-changed')); onDone(); }
  }

  const results = (result?.rows ?? []) as Row[];
  const ok = (result?.created ?? 0) + (result?.linked ?? 0) + (result?.updated ?? 0);
  return (
    <div className="panel-box">
      <div className="form-actions">
        <span>Template:</span>
        <button type="button" className="btn" onClick={() => downloadTemplate(kind, 'xlsx')}><Download size={15} /> Excel</button>
        <button type="button" className="btn" onClick={() => downloadTemplate(kind, 'csv')}><Download size={15} /> CSV</button>
      </div>
      <p className="muted small">Required: {t.required}. Columns: {t.columns.join(', ')}.</p>
      {t.duplicates && (
        <label className="field"><span>{kind === 'campaigns' ? 'Campaign IDs already here' : 'Donors already on file (same email or phone)'}</span>
          <select value={dup} onChange={e => { setDup(e.target.value); setResult(null); if (rows) void go(rows, false); }} disabled={busy}>
            {t.duplicates.map(d => <option key={d} value={d}>{DUP_LABEL[d]}</option>)}
          </select>
        </label>
      )}
      <label className="field"><span>File (.xlsx or .csv, up to 10 MB)</span>
        <input type="file" accept=".csv,.xlsx" onChange={e => pick(e.target.files?.[0])} disabled={busy} />
      </label>
      {error && <div className="error">{error}</div>}
      {busy && <p className="muted">Checking every row…</p>}
      {result && (
        <>
          <div className={result.committed ? 'notice' : 'panel-box'}>
            {result.committed ? <b>Imported. </b> : <b>Preview, nothing saved yet. </b>}
            {result.created} new · {result.linked > 0 && `${result.linked} matched to donors on file · `}{result.updated > 0 && `${result.updated} updated · `}
            {result.skipped} skipped · {result.errors} with errors{result.conflicts > 0 && ` · ${result.conflicts} with different details from what's on file (they go to the Task Sheet)`}
          </div>
          <div className="table-wrap dialog-table"><table className="grid">
            <thead><tr><th>Row</th><th>Result</th><th>Details</th>{Object.keys(rows?.[0] ?? {}).slice(0, 4).map(k => <th key={k}>{k}</th>)}</tr></thead>
            <tbody>{results.map(r => (
              <tr key={r.row}><td>{r.row + 1}</td><td><Pill tone={STATUS_TONE[r.status] ?? ''}>{r.status}</Pill></td><td>{r.message ?? r.record ?? ''}</td>
                {Object.values(rows?.[r.row - 1] ?? {}).slice(0, 4).map((v, i) => <td key={i}>{v}</td>)}</tr>
            ))}</tbody>
          </table></div>
          <p className="muted small">Row numbers count the header as row 1, as in the spreadsheet. Rows with errors are left out; fix them and import them separately if needed.</p>
          {!result.committed && (
            <div className="form-actions"><div className="spacer" />
              <button type="button" className="btn primary" disabled={busy || ok === 0} onClick={() => rows && go(rows, true)}><Upload size={15} /> Import {ok} row{ok === 1 ? '' : 's'}</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function DataImportPage() {
  const { permissions } = useAuth();
  const [kind, setKind] = useState<Kind>('campaigns');
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const canRun = permissions?.includes('run_imports');
  const canReverse = permissions?.includes('reverse_imports');
  const log = useQuery(
    () => fetchAll((a, b) => supabase.from('imports').select('*').order('imported_at', { ascending: false }).range(a, b) as never),
    [version],
  );
  async function reverse(r: Row) {
    if (!confirm(`Reverse this ${r.kind} import from ${dateTime(r.imported_at)}? Everything it added is removed and anything it changed goes back.`)) return;
    setError(null);
    const { error: e } = await supabase.rpc('reverse_import', { p_import: r.id });
    if (e) return setError(e.message);
    clearLookups();
    setVersion(v => v + 1);
  }
  const within = (r: Row) => !r.reversed_at && Date.now() - new Date(r.imported_at).getTime() < 24 * 3600 * 1000;
  return (
    <section className="view narrow">
      {canRun ? (
        <div className="card">
          <h3>Data import</h3>
          <p className="muted small">At launch, import in this order: campaigns, then donors, then donation history, then pledges. A row that points at something not yet imported is flagged, never skipped quietly. Every import can be reversed within 24 hours.</p>
          <div className="tabs">
            {(['campaigns', 'donors', 'donations', 'pledges', 'fundraisers'] as Kind[]).map((k, i) => (
              <button key={k} className={kind === k ? 'active' : ''} onClick={() => setKind(k)}>{k === 'fundraisers' ? '' : `${i + 1}. `}{TEMPLATES[k].label}</button>
            ))}
          </div>
          <Importer key={kind} kind={kind} onDone={() => setVersion(v => v + 1)} />
        </div>
      ) : <p className="muted">Only the Super Admin can run imports. Contact lists can be imported from a campaign's page.</p>}
      {error && <div className="error">{error}</div>}
      <DataTable
        title="Import log"
        rows={(log.data as Row[]) ?? []}
        loading={log.loading}
        error={log.error}
        exportName="import-log"
        columns={[
          { key: 'imported_at', label: 'When', render: r => dateTime(r.imported_at), value: r => dateTime(r.imported_at) },
          { key: 'kind', label: 'Type' },
          { key: 'file_name', label: 'File' },
          { key: 'campaign_id', label: 'Campaign' },
          { key: 'created', label: 'New', align: 'right' },
          { key: 'linked', label: 'Matched', align: 'right' },
          { key: 'updated', label: 'Updated', align: 'right' },
          { key: 'skipped', label: 'Skipped', align: 'right' },
          { key: 'errors', label: 'Errors', align: 'right' },
          { key: 'imported_by', label: 'By' },
          { key: 'reversed', label: 'Reversed', value: r => (r.reversed_at ? `${dateTime(r.reversed_at)} by ${r.reversed_by}` : ''),
            render: r => (r.reversed_at ? `${dateTime(r.reversed_at)} by ${r.reversed_by}` : canReverse && within(r) ? <button type="button" className="link" onClick={() => reverse(r)}>Reverse</button> : '') },
        ]}
      />
    </section>
  );
}

export function ContactImportDialog({ campaignId, onClose }: { campaignId: string; onClose: () => void }) {
  return (
    <Overlay onClose={onClose}>
      <div className="form-head"><h2>Import a contact list</h2><button type="button" className="icon-btn" title="Close" onClick={onClose}><X size={18} /></button></div>
      <p className="muted small">Adds possible donors to campaign {campaignId}'s list, ready for outreach and tasks. No donations are created.
        Anyone already on file with the same phone or email is linked as they are; nothing on their profile is changed, and any differences go to the office to review.</p>
      <Importer kind="contacts" campaign={campaignId} onDone={() => {}} />
    </Overlay>
  );
}

/** On the Task Sheet: the contact list's details next to what's on file. */
export function ImportConflict({ conflictId, onAct }: { conflictId: string; onAct: (call: PromiseLike<{ error: { message: string } | null }>, action: string, note?: string | null) => void }) {
  const q = useQuery(async () => (await supabase.from('import_conflicts').select('*').eq('id', conflictId).maybeSingle()).data as Row | null, [conflictId]);
  const c = q.data as Row | null;
  if (!c) return null;
  const keys = [...new Set([...Object.keys(c.imported), ...Object.keys(c.on_file)])];
  return (
    <div className="panel-box">
      <div className="side-by-side">
        <div><h3>From the contact list</h3><dl className="record-facts">{keys.map(k => <Fragment key={k}><dt>{k}</dt><dd className="pre-line">{c.imported[k] ?? '—'}</dd></Fragment>)}</dl></div>
        <div><h3>On file</h3><dl className="record-facts">{keys.map(k => <Fragment key={k}><dt>{k}</dt><dd className="pre-line">{c.on_file[k] ?? '—'}</dd></Fragment>)}</dl></div>
      </div>
      <p className="muted small">Matched by {c.matched_by}. Nothing on file was changed. <Link to={`/donors/${encodeURIComponent(c.donor_id)}`}>Open the donor</Link> to update their profile if the new details are right.</p>
      <div className="form-actions"><div className="spacer" />
        <button type="button" className="btn primary" onClick={() => onAct(supabase.rpc('resolve_import_conflict', { p_conflict: conflictId }), 'resolved')}>Done</button>
      </div>
    </div>
  );
}
