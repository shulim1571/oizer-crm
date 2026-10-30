import { useEffect, useState, type FormEvent } from 'react';
import { X } from 'lucide-react';
import { supabase, type Row } from '../lib/supabase';
import { clearLookups, type Option } from '../lib/lookups';
import { fromLocalInput, toLocalInput } from '../lib/format';
import SearchSelect from './SearchSelect';

export interface Field {
  name: string;
  label: string;
  type?: 'text' | 'number' | 'textarea' | 'checkbox' | 'select' | 'search' | 'multi' | 'datetime' | 'date' | 'email';
  options?: Option[] | (() => Promise<Option[]>);
  required?: boolean;
  /** Free-text select: allow values not in the list. */
  freeText?: boolean;
  help?: string;
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
}

export default function RecordForm(p: Props) {
  const pk = p.pk ?? 'id';
  const isNew = !p.record;
  const [values, setValues] = useState<Row>(() => ({ ...p.defaults, ...p.record }));
  const [opts, setOpts] = useState<Record<string, Option[]>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    for (const f of p.fields) {
      if (typeof f.options === 'function') {
        f.options().then(o => setOpts(prev => ({ ...prev, [f.name]: o }))).catch(e => setError(e.message));
      } else if (f.options) {
        setOpts(prev => ({ ...prev, [f.name]: f.options as Option[] }));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = (k: string, v: unknown) => setValues(prev => ({ ...prev, [k]: v }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const payload: Row = {};
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
    if (!p.record || !confirm('Delete this record? This cannot be undone.')) return;
    const { error } = await supabase.from(p.table).delete().eq(pk, p.record[pk]);
    if (error) return setError(error.message);
    clearLookups();
    p.onSaved({ ...p.record, _deleted: true });
  }

  const body = (
    <form className="record-form" onSubmit={submit}>
      <div className="form-head">
        <h2>{p.title}</h2>
        {!p.inline && <button type="button" className="icon-btn" onClick={p.onClose}><X size={20} /></button>}
      </div>
      <div className="fields">
        {p.fields.map(f => (
          <label key={f.name} className={`field ${f.type === 'textarea' ? 'wide' : ''} ${f.type === 'checkbox' ? 'check' : ''}`}>
            <span>{f.label}{f.required && ' *'}</span>
            {renderInput(f)}
            {f.help && <small className="muted">{f.help}</small>}
          </label>
        ))}
      </div>
      {error && <div className="error">{error}</div>}
      <div className="form-actions">
        {!isNew && p.allowDelete && <button type="button" className="btn danger" onClick={remove}>Delete</button>}
        <div className="spacer" />
        {!p.inline && <button type="button" className="btn" onClick={p.onClose}>Cancel</button>}
        <button className="btn primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  );

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
        return <input type="date" value={v ?? ''} onChange={e => set(f.name, e.target.value)} required={f.required} />;
      case 'search':
        return <SearchSelect value={v ?? null} options={opts[f.name] ?? []} onChange={x => set(f.name, x)} required={f.required} />;
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
          <select value={v ?? ''} onChange={e => set(f.name, e.target.value)} required={f.required}>
            <option value="">—</option>
            {(opts[f.name] ?? []).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
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
                          onChange={x => x && set(f.name, [...arr, x])} placeholder="Add…" />
          </div>
        );
      }
      default:
        return <input type={f.type ?? 'text'} value={v ?? ''} onChange={e => set(f.name, e.target.value)} required={f.required} />;
    }
  }

  if (p.inline) return <div className="card">{body}</div>;
  return (
    <div className="modal-back" onMouseDown={e => e.target === e.currentTarget && p.onClose()}>
      <div className="modal">{body}</div>
    </div>
  );
}
