import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Plus, Trash2 } from 'lucide-react';
import SearchSelect from '../components/SearchSelect';
import { money } from '../lib/format';
import { campaignOptions, clearLookups, donorOptions, paymentMethodOptions, type Option } from '../lib/lookups';
import { supabase } from '../lib/supabase';

interface Line {
  key: number;
  name: string;
  createDonor: boolean;
  phone: string;
  amount: string;
  method: string;
  check: string;
  notes: string;
}

let nextKey = 1;
const blank = (method = ''): Line => ({ key: nextKey++, name: '', createDonor: false, phone: '', amount: '', method, check: '', notes: '' });

/** Many donations from one outing, typed like a spreadsheet and submitted together. */
export default function BatchEntry() {
  const { id } = useParams();
  const [campaign, setCampaign] = useState<string | null>(id ?? null);
  const [campaigns, setCampaigns] = useState<Option[]>([]);
  const [donors, setDonors] = useState<Option[]>([]);
  const [methods, setMethods] = useState<Option[]>([]);
  const [lines, setLines] = useState<Line[]>([blank(), blank()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  // Sent with the batch, so a retry can't post it twice.
  const clientKey = useRef(crypto.randomUUID());
  const focusNew = useRef(false);
  const table = useRef<HTMLTableSectionElement>(null);

  useEffect(() => {
    campaignOptions().then(setCampaigns);
    donorOptions().then(setDonors);
    paymentMethodOptions().then(setMethods);
  }, []);

  useEffect(() => {
    if (!focusNew.current) return;
    focusNew.current = false;
    table.current?.querySelector<HTMLInputElement>('tr:last-child input')?.focus();
  }, [lines.length]);

  const update = (key: number, patch: Partial<Line>) => setLines(ls => ls.map(l => (l.key === key ? { ...l, ...patch } : l)));
  const addLine = (focus = false) => {
    focusNew.current = focus;
    setLines(ls => [...ls, blank(ls[ls.length - 1]?.method ?? '')]);
  };
  const donorFor = (name: string) => donors.find(d => d.label === name);
  const filled = lines.filter(l => l.amount || l.name || l.notes);
  const total = filled.reduce((s, l) => s + (Number(l.amount) || 0), 0);

  async function submit() {
    setError(null);
    if (!campaign) return setError('Choose a campaign first.');
    if (!filled.length) return setError('Enter at least one donation.');
    const problem = filled.findIndex(l => !(Number(l.amount) > 0) || !l.method);
    if (problem >= 0) return setError(`Row ${lines.indexOf(filled[problem]) + 1} needs an amount and a payment method.`);

    setBusy(true);
    const { data, error: e } = await supabase.rpc('submit_batch', {
      p_campaign: campaign,
      p_client_key: clientKey.current,
      p_rows: filled.map(l => {
        const donor = donorFor(l.name);
        return {
          amount: Number(l.amount),
          payment_method: l.method,
          donor_id: donor?.value ?? null,
          name: donor ? null : l.name || null,
          create_donor: !donor && l.createDonor,
          phone: l.phone || null,
          check_number: l.check || null,
          notes: l.notes || null,
        };
      }),
    });
    setBusy(false);
    if (e) return setError(e.message);
    clearLookups();
    donorOptions().then(setDonors);
    clientKey.current = crypto.randomUUID();
    setSaved(`Batch ${data} saved: ${filled.length} donation${filled.length === 1 ? '' : 's'} totaling ${money(total)}.`);
    setLines([blank(), blank()]);
  }

  return (
    <section className="view">
      <div className="view-head">
        <div className="view-title"><h1>Batch Entry</h1><span className="count">One row per donation. Tab moves along; Tab from the last box adds a row.</span></div>
      </div>
      {saved && <div className="notice">{saved} {campaign && <Link to={`/campaigns/${encodeURIComponent(campaign)}`}>Open campaign</Link>}</div>}
      <div className="batch-campaign">
        <label className="field"><span>Campaign *</span>
          <SearchSelect value={campaign} options={campaigns} onChange={setCampaign} placeholder="Campaign…" />
        </label>
      </div>
      <datalist id="batch-donors">{donors.map(d => <option key={d.value} value={d.label} />)}</datalist>
      <datalist id="batch-methods">{methods.map(m => <option key={m.value} value={m.value} />)}</datalist>
      <div className="table-card"><div className="table-wrap">
        <table className="grid batch-grid">
          <thead><tr><th>Donor (optional)</th><th>Phone</th><th>Amount *</th><th>Method *</th><th>Check #</th><th>Notes</th><th /></tr></thead>
          <tbody ref={table}>
            {lines.map((l, i) => {
              const known = donorFor(l.name);
              return (
                <tr key={l.key}>
                  <td>
                    <input list="batch-donors" aria-label={`Donor, row ${i + 1}`} value={l.name} placeholder="Anonymous if empty" onChange={e => update(l.key, { name: e.target.value })} />
                    {l.name && (known
                      ? <div className="muted small">Linked to existing donor</div>
                      : <label className="muted small"><input type="checkbox" checked={l.createDonor} onChange={e => update(l.key, { createDonor: e.target.checked })} /> Create new donor</label>)}
                  </td>
                  <td><input aria-label={`Phone, row ${i + 1}`} value={l.phone} onChange={e => update(l.key, { phone: e.target.value })} /></td>
                  <td><input type="number" step="0.01" min="0" aria-label={`Amount, row ${i + 1}`} value={l.amount} onChange={e => update(l.key, { amount: e.target.value })} /></td>
                  <td><input list="batch-methods" aria-label={`Method, row ${i + 1}`} value={l.method} onChange={e => update(l.key, { method: e.target.value })} /></td>
                  <td><input aria-label={`Check number, row ${i + 1}`} value={l.check} disabled={!/check/i.test(l.method)} onChange={e => update(l.key, { check: e.target.value })} /></td>
                  <td>
                    <input aria-label={`Notes, row ${i + 1}`} value={l.notes} onChange={e => update(l.key, { notes: e.target.value })}
                           onKeyDown={e => {
                             if (i === lines.length - 1 && ((e.key === 'Tab' && !e.shiftKey) || e.key === 'Enter')) {
                               e.preventDefault();
                               addLine(true);
                             }
                           }} />
                  </td>
                  <td>
                    {lines.length > 1 && (
                      <button className="icon-btn" tabIndex={-1} title="Remove row" onClick={() => setLines(ls => ls.filter(x => x.key !== l.key))}><Trash2 size={14} /></button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="table-foot">
        <span><b>{filled.length}</b> {filled.length === 1 ? 'entry' : 'entries'} · <b>{money(total)}</b></span>
        <div className="pager">
          <button className="btn" onClick={() => addLine()}><Plus size={16} /> Add row</button>
          <button className="btn primary" disabled={busy} onClick={submit}>{busy ? 'Saving…' : 'Submit all'}</button>
        </div>
      </div></div>
      {error && <div className="error">{error}</div>}
    </section>
  );
}
