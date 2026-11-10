import CampaignBalanceNote from './CampaignBalanceNote';
import { NewDonorDialog } from './DonorPicker';
import { useEffect, useState, type FormEvent } from 'react';
import { X } from 'lucide-react';
import { supabase, type Row } from '../lib/supabase';
import { clearLookups, type Option } from '../lib/lookups';
import { fromLocalInput, toLocalInput } from '../lib/format';
import { useAuth } from '../lib/auth';
import DateNote from './DateNote';
import SearchSelect from './SearchSelect';
import DonationActions from '../pages/DonationActions';
import { PayoutCheckActions } from '../pages/Checks';
import { ReceiptActions } from '../pages/Receipts';

export interface Field {
  name: string;
  label: string;
  type?: 'text' | 'number' | 'textarea' | 'checkbox' | 'select' | 'search' | 'multi' | 'datetime' | 'date' | 'email';
  options?: Option[] | (() => Promise<Option[]>);
  required?: boolean;
  /** Free-text select: allow values not in the list. */
  freeText?: boolean;
  help?: string;
  /** Kept in a folded "Advanced / accounting" section (it opens when any of them has a value). */
  advanced?: boolean;
  /** How to make a new one from right here, without leaving this form. */
  create?: () => { noun: string; table: string; fields: Field[]; defaults?: Row; pk?: string };
}

interface Props {
  table: string;
  title: string;
  fields: Field[];
  record?: Row | null;
  defaults?: Row;
  /** Primary key column; defaults to "id". */
  pk?: string;
  onClose: () => void;
  onSaved: (row: Row) => void;
  /** Render inline instead of as a modal dialog. */
  inline?: boolean;
  allowDelete?: boolean;
  /** Bulk edit: hands back only the fields filled in, instead of saving a record. */
  onBulk?: (patch: Row) => void;
  bulkError?: string | null;
  /** Says what the button saves, e.g. "Save branding". */
  saveLabel?: string;
  /** A line under the title. */
  description?: string;
}

const NEW_OPTION = '__create_new__';

export default function RecordForm(p: Props) {
  const { isAdmin, canWork } = useAuth();
  const pk = p.pk ?? 'id';
  const isNew = !p.record;
  const [creating, setCreating] = useState<Field | null>(null);
  const [values, setValues] = useState<Row>(() => ({ ...p.defaults, ...p.record }));
  const [opts, setOpts] = useState<Record<string, Option[]>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadOptions = (fields: Field[]) => {
    for (const f of fields) {
      if (typeof f.options === 'function') {
        f.options().then(o => setOpts(prev => ({ ...prev, [f.name]: o }))).catch(e => setError(e.message));
      } else if (f.options) {
        setOpts(prev => ({ ...prev, [f.name]: f.options as Option[] }));
      }
    }
  };

  useEffect(() => {
    loadOptions(p.fields);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Admins can add anything from here; fundraisers can add a donor (through their own donor form).
  const createFor = (f: Field) => (f.create && (isAdmin || (canWork && f.create().table === 'donors')) ? { onCreate: () => setCreating(f), createLabel: f.create().noun } : {});

  // The new record is selected, and everything already typed in this form stays as it was.
  function created(f: Field, row: Row) {
    setCreating(null);
    clearLookups();
    loadOptions(p.fields);
    const id = row[f.create!().pk ?? 'id'];
    if (f.type === 'multi') set(f.name, [...(values[f.name] ?? []), id]);
    else set(f.name, id);
  }

  const set = (k: string, v: unknown) => setValues(prev => ({ ...prev, [k]: v }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (p.onBulk) {
      const patch: Row = {};
      for (const f of p.fields) {
        const v = values[f.name];
        if (v !== '' && v != null) patch[f.name] = f.type === 'number' ? Number(v) : v;
      }
      return p.onBulk(patch);
    }
    setSaving(true);
    setError(null);
    const payload: Row = isNew ? { ...p.defaults } : {};
    for (const f of p.fields) {
      let v = values[f.name];
      if (v === '' || v === undefined) v = null;
      if (f.type === 'number' && v != null) v = Number(v);
      if (f.type === 'checkbox') v = !!v;
      if (f.type === 'multi') v = v ?? [];
      payload[f.name] = v;
    }
    if (isNew && values[pk] != null && !(pk in payload)) payload[pk] = values[pk];
    const q = isNew
      ? supabase.from(p.table).insert(payload).select().single()
      : supabase.from(p.table).update(payload).eq(pk, p.record![pk]).select().single();
    const { data, error } = await q;
    setSaving(false);
    if (error) return setError(error.message);
    clearLookups();
    p.onSaved(data);
  }

  async function remove() {
    if (!p.record || !confirm('Delete this record? It will be hidden everywhere but kept on file.')) return;
    const { error } = await supabase.from(p.table).delete().eq(pk, p.record[pk]);
    if (error) return setError(error.message);
    clearLookups();
    p.onSaved({ ...p.record, _deleted: true });
  }

  const nested = creating && (() => {
    const spec = creating.create!();
    if (spec.table === 'donors') return <NewDonorDialog onClose={() => setCreating(null)} onSaved={row => created(creating, row)} />;
    return (
      <RecordForm
        table={spec.table}
        pk={spec.pk}
        title={`New ${spec.noun}`}
        fields={spec.fields}
        defaults={spec.defaults}
        onClose={() => setCreating(null)}
        onSaved={row => created(creating, row)}
      />
    );
  })();

  const body = (
    <form className="record-form" onSubmit={submit}>
      <div className="form-head">
        <h2>{p.title}</h2>
        {!p.inline && <button type="button" className="icon-btn" onClick={p.onClose}><X size={20} /></button>}
      </div>
      {p.description && <p className="muted small form-desc">{p.description}</p>}
      <div className="fields">
        {p.fields.filter(f => !f.advanced).map(fieldBox)}
      </div>
      {p.fields.some(f => f.advanced) && (
        <details className="help advanced-fields" open={p.fields.some(f => f.advanced && !isNew && values[f.name] != null && values[f.name] !== '' && values[f.name] !== false)}>
          <summary>Advanced / accounting</summary>
          <div className="fields">{p.fields.filter(f => f.advanced).map(fieldBox)}</div>
        </details>
      )}
      {p.table === 'expenses' && !p.onBulk && <CampaignBalanceNote campaignId={values.campaign_id} amount={values.amount} />}
      {(error || p.bulkError) && <div className="error">{error ?? p.bulkError}</div>}
      {p.onBulk && <p className="muted small">Only fields you fill in are changed. Everything else stays as it is on each transaction.</p>}
      {p.table === 'donations' && !isNew && !p.onBulk && isAdmin && <DonationActions record={p.record!} onDone={p.onSaved} />}
      {p.table === 'donations' && !isNew && !p.onBulk && isAdmin && <ReceiptActions donationId={p.record!.id} />}
      {p.table === 'expenses' && !isNew && !p.onBulk && isAdmin && <PayoutCheckActions record={p.record!} onDone={() => {}} />}
      <div className="form-actions">
        {!isNew && p.allowDelete && p.table !== 'donations' && <button type="button" className="btn danger" onClick={remove}>Delete</button>}
        <div className="spacer" />
        {!p.inline && <button type="button" className="btn" onClick={p.onClose}>Cancel</button>}
        <button className="btn primary" disabled={saving}>{saving ? 'Saving…' : p.onBulk ? 'Review changes' : p.saveLabel ?? 'Save'}</button>
      </div>
    </form>
  );

  function fieldBox(f: Field) {
    return (
      <label key={f.name} className={`field ${f.type === 'textarea' ? 'wide' : ''} ${f.type === 'checkbox' ? 'check' : ''}`}>
        <span>{f.label}{f.required && ' *'}</span>
        {renderInput(f)}
        {f.help && <small className="muted">{f.help}</small>}
      </label>
    );
  }

  function renderInput(f: Field) {
    const v = values[f.name];
    switch (f.type) {
      case 'textarea':
        return <textarea rows={3} value={v ?? ''} onChange={e => set(f.name, e.target.value)} required={f.required} />;
      case 'checkbox':
        return <input type="checkbox" checked={!!v} onChange={e => set(f.name, e.target.checked)} />;
      case 'number':
        return <input type="number" step="0.01" value={v ?? ''} onChange={e => set(f.name, e.target.value)} required={f.required} />;
      case 'datetime':
        return <input type="datetime-local" value={v ? toLocalInput(v) : ''} onChange={e => set(f.name, e.target.value ? fromLocalInput(e.target.value) : null)} required={f.required} />;
      case 'date':
        return <><input type="date" value={v ?? ''} onChange={e => set(f.name, e.target.value)} required={f.required} /><DateNote date={v} /></>;
      case 'search':
        return <SearchSelect value={v ?? null} options={opts[f.name] ?? []} onChange={x => set(f.name, x)} required={f.required} {...createFor(f)} />;
      case 'select':
        if (f.freeText) {
          return (
            <>
              <input list={`dl-${f.name}`} value={v ?? ''} onChange={e => set(f.name, e.target.value)} required={f.required} />
              <datalist id={`dl-${f.name}`}>{(opts[f.name] ?? []).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</datalist>
            </>
          );
        }
        return (
          <select value={v ?? ''} required={f.required}
                  onChange={e => (e.target.value === NEW_OPTION ? setCreating(f) : set(f.name, e.target.value))}>
            <option value="">—</option>
            {(opts[f.name] ?? []).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            {f.create && isAdmin && <option value={NEW_OPTION}>+ Create new {f.create().noun}</option>}
          </select>
        );
      case 'multi': {
        const arr: string[] = v ?? [];
        return (
          <div className="multi">
            {arr.map(id => (
              <span key={id} className="chip">
                {(opts[f.name] ?? []).find(o => o.value === id)?.label ?? id}
                <button type="button" onClick={() => set(f.name, arr.filter(x => x !== id))}><X size={12} /></button>
              </span>
            ))}
            <SearchSelect value={null} options={(opts[f.name] ?? []).filter(o => !arr.includes(o.value))}
                          onChange={x => x && set(f.name, [...arr, x])} placeholder="Add…" {...createFor(f)} />
          </div>
        );
      }
      default:
        return <input type={f.type ?? 'text'} value={v ?? ''} onChange={e => set(f.name, e.target.value)} required={f.required} />;
    }
  }

  if (p.inline) return <div className="card">{body}{nested}</div>;
  return (
    <div className="modal-back" onMouseDown={e => e.target === e.currentTarget && p.onClose()}>
      <div className="modal">{body}{nested}</div>
    </div>
  );
}
