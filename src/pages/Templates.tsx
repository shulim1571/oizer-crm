import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, Trash2 } from 'lucide-react';
import DataTable, { type Column } from '../components/DataTable';
import { Pill } from '../components/Pill';
import { money } from '../lib/format';
import { accountOptions, clearLookups, paymentMethodIdOptions, type Option } from '../lib/lookups';
import { fetchAll, supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';
import { ReceiptTextCard } from './Receipts';

const LANGUAGES = [['en', 'English'], ['he', 'Hebrew'], ['yi', 'Yiddish']];
const FIELD_TYPES = [['text', 'Text'], ['number', 'Number'], ['date', 'Date'], ['dropdown', 'Dropdown'], ['checkbox', 'Checkbox']];

const blankSettings = (): Row => ({
  language: 'en', preset_amounts: [], allow_other_amount: true, cover_fee_default: false, min_donation: null,
  auto_receipt: false, receipt_email: true, receipt_sms: false, donor_wall: false, logo_url: null, brand_color: null, custom_fields: [],
});
const pickSettings = (r: Row | null | undefined): Row => {
  const base = blankSettings();
  return Object.fromEntries(Object.keys(base).map(k => [k, r?.[k] ?? base[k]]));
};

/** The page settings, shared by templates, new campaigns and a campaign's own settings. */
export function SettingsFields({ value, onChange }: { value: Row; onChange: (v: Row) => void }) {
  const set = (k: string, v: unknown) => onChange({ ...value, [k]: v });
  const fields: Row[] = value.custom_fields ?? [];
  const setField = (i: number, patch: Row) => set('custom_fields', fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const check = (k: string, label: string) => (
    <label className="inline-check"><input type="checkbox" checked={!!value[k]} onChange={e => set(k, e.target.checked)} /> {label}</label>
  );
  return (
    <>
      <div className="fields">
        <label className="field"><span>Page language</span>
          <select value={value.language} onChange={e => set('language', e.target.value)}>
            {LANGUAGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label className="field"><span>Preset amounts</span>
          <input
            placeholder="18, 36, 180"
            defaultValue={(value.preset_amounts ?? []).map(Number).join(', ')}
            onBlur={e => set('preset_amounts', e.target.value.split(',').map(x => Number(x.trim())).filter(x => x > 0))}
          />
        </label>
        <label className="field"><span>Minimum donation</span>
          <input type="number" step="0.01" min="0" value={value.min_donation ?? ''} onChange={e => set('min_donation', e.target.value === '' ? null : Number(e.target.value))} />
        </label>
        <label className="field"><span>Logo address</span>
          <input value={value.logo_url ?? ''} placeholder="Empty uses the default" onChange={e => set('logo_url', e.target.value)} />
        </label>
        <label className="field"><span>Brand color</span>
          <input value={value.brand_color ?? ''} placeholder="Empty uses the default" onChange={e => set('brand_color', e.target.value)} />
        </label>
      </div>
      <div className="check-row">
        {check('allow_other_amount', 'Donors can enter any amount')}
        {check('cover_fee_default', 'Cover the fee on by default')}
        {check('donor_wall', 'Donor wall')}
        {check('auto_receipt', 'Send receipts automatically')}
        {value.auto_receipt && check('receipt_email', 'By email')}
        {value.auto_receipt && check('receipt_sms', 'By SMS')}
      </div>
      <div className="dialog-section"><h3>Custom fields</h3>
        <button type="button" className="link" onClick={() => set('custom_fields', [...fields, { name: '', type: 'text', required: false }])}>+ Add a field</button>
      </div>
      {fields.map((f, i) => (
        <div className="custom-field-row" key={i}>
          <input aria-label="Field name" placeholder="Field name" value={f.name} onChange={e => setField(i, { name: e.target.value })} />
          <select aria-label="Field type" value={f.type} onChange={e => setField(i, { type: e.target.value })}>
            {FIELD_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <label className="inline-check"><input type="checkbox" checked={!!f.required} onChange={e => setField(i, { required: e.target.checked })} /> Required</label>
          <button type="button" className="icon-btn" title="Remove" onClick={() => set('custom_fields', fields.filter((_, j) => j !== i))}><Trash2 size={14} /></button>
        </div>
      ))}
    </>
  );
}

const columns: Column[] = [
  { key: 'name', label: 'Template', width: 220, render: r => <>{r.name}{r.is_default && <> <Pill tone="green">Default</Pill></>}</> },
  { key: 'description', label: 'Description', width: 240 },
  { key: 'language', label: 'Language', value: r => LANGUAGES.find(([v]) => v === r.language)?.[1] },
  { key: 'preset_amounts', label: 'Preset amounts', value: r => (r.preset_amounts ?? []).map((a: number) => money(a)).join(', ') },
  { key: 'custom_fields', label: 'Custom fields', value: r => (r.custom_fields ?? []).length, align: 'right' },
];

export function TemplatesPage() {
  const [version, setVersion] = useState(0);
  const [editing, setEditing] = useState<Row | null | undefined>(undefined);
  const q = useQuery(
    () => fetchAll((a, b) => supabase.from('campaign_templates').select('*').order('name').range(a, b) as never),
    [version],
  );
  return (
    <section className="view">
      <DataTable
        title="Campaign Templates"
        rows={(q.data as Row[]) ?? []}
        loading={q.loading}
        error={q.error}
        columns={columns}
        exportName="campaign-templates"
        onOpen={setEditing}
        actions={<button className="btn primary" onClick={() => setEditing(null)}><Plus size={16} /> New template</button>}
      />
      {editing !== undefined && <TemplateDialog record={editing} onClose={() => setEditing(undefined)} onDone={() => { setEditing(undefined); setVersion(v => v + 1); }} />}
    </section>
  );
}

function TemplateDialog({ record, onClose, onDone }: { record: Row | null; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState<string>(record?.name ?? '');
  const [description, setDescription] = useState<string>(record?.description ?? '');
  const [settings, setSettings] = useState<Row>(pickSettings(record));
  const [account, setAccount] = useState<string>(record?.account_id ?? '');
  const [fees, setFees] = useState<Row[]>(record?.fee_overrides ?? []);
  const [accounts, setAccounts] = useState<Option[]>([]);
  const [methods, setMethods] = useState<Option[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    accountOptions().then(setAccounts);
    paymentMethodIdOptions().then(setMethods);
  }, []);
  const setFee = (i: number, patch: Row) => setFees(f => f.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  async function save() {
    setError(null);
    const payload = { name, description: description || null, ...settings, account_id: account || null, fee_overrides: fees.filter(f => f.method_id) };
    const { error: e } = record
      ? await supabase.from('campaign_templates').update(payload).eq('id', record.id)
      : await supabase.from('campaign_templates').insert(payload);
    if (e) return setError(/campaign_templates_name/.test(e.message) ? 'There is already a template with that name.' : e.message);
    clearLookups();
    onDone();
  }
  async function run(call: PromiseLike<{ error: { message: string } | null }>, confirmText?: string) {
    if (confirmText && !confirm(confirmText)) return;
    setError(null);
    const { error: e } = await call;
    if (e) return setError(e.message);
    onDone();
  }

  return createPortal(
    <div className="modal-back" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-wide"><div className="record-form">
        <div className="form-head"><h2>{record ? `Edit ${record.name}` : 'New template'}</h2></div>
        <p className="muted small">Campaign name, fundraisers and goal are always entered fresh. Editing a template doesn't change campaigns already made from it.</p>
        <div className="fields">
          <label className="field"><span>Name *</span><input value={name} onChange={e => setName(e.target.value)} /></label>
          <label className="field"><span>Description</span><input value={description} onChange={e => setDescription(e.target.value)} /></label>
          <label className="field"><span>Default bank account</span>
            <select value={account} onChange={e => setAccount(e.target.value)}>
              <option value="">Not set</option>
              {accounts.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
            </select>
          </label>
        </div>
        <SettingsFields value={settings} onChange={setSettings} />
        <div className="dialog-section"><h3>Fee overrides</h3>
          <button type="button" className="link" onClick={() => setFees(f => [...f, { method_id: '', fee_type: 'percent', fee_percent: 0, fee_flat: 0 }])}>+ Add a fee</button>
        </div>
        {fees.map((f, i) => (
          <div className="custom-field-row" key={i}>
            <select aria-label="Method" value={f.method_id} onChange={e => setFee(i, { method_id: e.target.value })}>
              <option value="">Method…</option>
              {methods.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
            <select aria-label="Fee type" value={f.fee_type} onChange={e => setFee(i, { fee_type: e.target.value })}>
              <option value="none">None</option><option value="flat">Flat $</option><option value="percent">% rate</option><option value="percent_flat">% + flat</option>
            </select>
            <input aria-label="% rate" type="number" step="0.01" min="0" placeholder="%" value={f.fee_percent ?? 0} onChange={e => setFee(i, { fee_percent: Number(e.target.value) })} />
            <input aria-label="Flat $" type="number" step="0.01" min="0" placeholder="$" value={f.fee_flat ?? 0} onChange={e => setFee(i, { fee_flat: Number(e.target.value) })} />
            <button type="button" className="icon-btn" title="Remove" onClick={() => setFees(x => x.filter((_, j) => j !== i))}><Trash2 size={14} /></button>
          </div>
        ))}
        {error && <div className="error">{error}</div>}
        <div className="form-actions">
          {record && <button type="button" className="btn danger" onClick={() => run(supabase.from('campaign_templates').delete().eq('id', record.id), 'Delete this template? Campaigns already made from it stay as they are.')}>Delete</button>}
          {record && !record.is_default && <button type="button" className="btn" onClick={() => run(supabase.rpc('set_default_template', { p_template: record.id }))}>Make default</button>}
          {record?.is_default && <button type="button" className="btn" onClick={() => run(supabase.rpc('set_default_template', { p_template: null }))}>Stop being default</button>}
          <div className="spacer" />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={!name.trim()} onClick={save}>Save</button>
        </div>
      </div></div>
    </div>,
    document.body,
  );
}

/** Choose a template and adjust its settings. They're saved once the campaign itself exists. */
export function TemplateStep({ onNext, onClose }: { onNext: (choice: { template: Row | null; settings: Row | null }) => void; onClose: () => void }) {
  const [templates, setTemplates] = useState<Row[]>([]);
  const [chosen, setChosen] = useState('');
  const [settings, setSettings] = useState<Row>(blankSettings());
  useEffect(() => {
    supabase.from('campaign_templates').select('*').order('name').then(({ data }) => {
      const list = (data ?? []) as Row[];
      setTemplates(list);
      const preset = list.find(t => t.is_default);
      if (preset) {
        setChosen(preset.id);
        setSettings(pickSettings(preset));
      }
    });
  }, []);
  const template = templates.find(t => t.id === chosen) ?? null;

  return createPortal(
    <div className="modal-back" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-wide"><div className="record-form">
        <div className="form-head"><h2>New campaign</h2></div>
        <label className="field"><span>Start from</span>
          <select value={chosen} onChange={e => { setChosen(e.target.value); setSettings(pickSettings(templates.find(t => t.id === e.target.value))); }}>
            <option value="">Scratch</option>
            {templates.map(t => <option key={t.id} value={t.id}>{t.name}{t.is_default ? ' (default)' : ''}</option>)}
          </select>
        </label>
        {/* The key redraws the fields when a template replaces their values. */}
        <div key={chosen}><SettingsFields value={settings} onChange={setSettings} /></div>
        <div className="form-actions">
          <div className="spacer" />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" onClick={() => onNext({ template, settings })}>Continue</button>
        </div>
      </div></div>
    </div>,
    document.body,
  );
}

/** The public payment page: its address, whether it's on, and what it says beyond the amounts. */
function PageContentCard({ campaignId, current, onSaved }: { campaignId: string; current: Row | null; onSaved: () => void }) {
  const [v, setV] = useState({ page_enabled: true, cover_fee_enabled: true, suggested: '', description: '', thank_you: '', banner_url: '' });
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setV({
      page_enabled: current?.page_enabled ?? true, cover_fee_enabled: current?.cover_fee_enabled ?? true,
      suggested: current?.suggested_amount != null ? String(current.suggested_amount) : '', description: current?.description ?? '',
      thank_you: current?.thank_you ?? '', banner_url: current?.banner_url ?? '',
    });
  }, [current]);
  const link = `${window.location.origin}${import.meta.env.BASE_URL}give/${encodeURIComponent(campaignId)}`;
  async function save() {
    setMessage(null);
    setError(null);
    const { error: e } = await supabase.rpc('save_page_content', {
      p_campaign: campaignId, p_page_enabled: v.page_enabled, p_cover_fee_enabled: v.cover_fee_enabled, p_suggested: v.suggested ? Number(v.suggested) : null,
      p_description: v.description, p_thank_you: v.thank_you, p_banner_url: v.banner_url,
    });
    if (e) return setError(e.message);
    setMessage('Saved.');
    onSaved();
  }
  return (
    <div className="panel-box">
      <h3>Payment page</h3>
      <p className="small"><a href={link} target="_blank" rel="noreferrer">{link}</a></p>
      <div className="check-row">
        <label className="inline-check"><input type="checkbox" checked={v.page_enabled} onChange={e => setV({ ...v, page_enabled: e.target.checked })} /> Page takes donations</label>
        <label className="inline-check"><input type="checkbox" checked={v.cover_fee_enabled} onChange={e => setV({ ...v, cover_fee_enabled: e.target.checked })} /> Offer "cover the fee"</label>
      </div>
      <div className="fields">
        <label className="field"><span>Suggested amount</span><input type="number" min="0" step="0.01" value={v.suggested} onChange={e => setV({ ...v, suggested: e.target.value })} placeholder="One of the presets" /></label>
        <label className="field"><span>Banner image address</span><input value={v.banner_url} onChange={e => setV({ ...v, banner_url: e.target.value })} placeholder="https://… (1200×400)" /></label>
        <label className="field wide"><span>Description or story</span><textarea rows={4} dir="auto" value={v.description} onChange={e => setV({ ...v, description: e.target.value })} /></label>
        <label className="field wide"><span>Thank-you message</span><textarea rows={2} dir="auto" value={v.thank_you} onChange={e => setV({ ...v, thank_you: e.target.value })} /></label>
      </div>
      {message && <div className="notice">{message}</div>}
      {error && <div className="error">{error}</div>}
      <div className="form-actions"><div className="spacer" /><button type="button" className="btn" onClick={save}>Save page</button></div>
    </div>
  );
}

/** A campaign's own page settings, used by its public payment page. */
export function CampaignSettingsTab({ campaignId }: { campaignId: string }) {
  const q = useQuery(async () => (await supabase.from('campaign_page_settings').select('*').eq('campaign_id', campaignId).maybeSingle()).data as Row | null, [campaignId]);
  const [settings, setSettings] = useState<Row | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (!q.loading) setSettings(pickSettings(q.data)); }, [q.loading, q.data]);

  async function save() {
    setMessage(null);
    setError(null);
    const { error: e } = await supabase.rpc('save_campaign_settings', { p_campaign: campaignId, p_settings: settings });
    if (e) return setError(e.message);
    setMessage('Saved.');
  }

  if (!settings) return <p className="muted pad">Loading…</p>;
  return (
    <div className="table-card pad">
      <PageContentCard campaignId={campaignId} current={q.data as Row | null} onSaved={() => void q.reload()} />
      <div key={q.data?.updated_at ?? 'new'}><SettingsFields value={settings} onChange={setSettings} /></div>
      <ReceiptTextCard level="campaign" refId={campaignId} title="Receipt text for this campaign" />
      {message && <div className="notice">{message}</div>}
      {error && <div className="error">{error}</div>}
      <div className="form-actions">
        <div className="spacer" />
        <button type="button" className="btn primary" onClick={save}>Save settings</button>
      </div>
    </div>
  );
}
