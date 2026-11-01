import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, GripVertical, Star, Trash2 } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { supabase, type Row } from '../lib/supabase';
import type { Column } from './DataTable';

export interface TableConfig {
  columns?: string[];
  widths?: Record<string, number>;
  freeze?: number;
  compact?: boolean;
  pageSize?: number;
  sort?: { key: string; dir: 'asc' | 'desc' } | null;
  filters?: Record<string, string>;
}

export interface SavedViews {
  ready: boolean;
  config: TableConfig;
  setConfig: (c: TableConfig) => void;
  views: Row[];
  activeName: string | null;
  apply: (view: Row | null) => void;
  save: (name: string) => Promise<string | null>;
  update: () => Promise<string | null>;
  remove: (view: Row) => Promise<void>;
  setDefault: (view: Row, on: boolean) => Promise<void>;
}

/** The current layout, plus this person's saved views for the table. A saved default loads first. */
export function useSavedViews(tableKey: string, enabled: boolean): SavedViews {
  const { profile } = useAuth();
  const [views, setViews] = useState<Row[]>([]);
  const [config, setConfig] = useState<TableConfig>({});
  const [active, setActive] = useState<Row | null>(null);
  const [ready, setReady] = useState(!enabled);
  const userId = profile?.user_id as string | undefined;

  const load = useCallback(async () => {
    const { data } = await supabase.from('saved_views').select('*').eq('table_key', tableKey).order('name');
    setViews(data ?? []);
    return data ?? [];
  }, [tableKey]);

  useEffect(() => {
    if (!enabled || !userId) return;
    let live = true;
    load().then(list => {
      if (!live) return;
      const def = list.find(v => v.is_default);
      if (def) {
        setConfig(def.config as TableConfig);
        setActive(def);
      }
      setReady(true);
    }, () => live && setReady(true));
    return () => { live = false; };
  }, [enabled, userId, load]);

  return {
    ready,
    config,
    setConfig,
    views,
    activeName: active?.name ?? null,
    apply: view => {
      setActive(view);
      setConfig((view?.config as TableConfig | undefined) ?? {});
    },
    save: async name => {
      const { data, error } = await supabase.from('saved_views').insert({ table_key: tableKey, name: name.trim(), config }).select().single();
      if (error) return error.code === '23505' ? 'You already have a view with that name.' : error.message;
      setActive(data);
      await load();
      return null;
    },
    update: async () => {
      if (!active) return null;
      const { error } = await supabase.from('saved_views').update({ config }).eq('id', active.id);
      if (error) return error.message;
      await load();
      return null;
    },
    remove: async view => {
      await supabase.from('saved_views').delete().eq('id', view.id);
      if (active?.id === view.id) setActive(null);
      await load();
    },
    setDefault: async (view, on) => {
      await supabase.from('saved_views').update({ is_default: false }).eq('table_key', tableKey).eq('is_default', true);
      if (on) await supabase.from('saved_views').update({ is_default: true }).eq('id', view.id);
      await load();
    },
  };
}

export default function TableCustomize({ columns, visibleKeys, saved, onClose }: {
  columns: Column[];
  visibleKeys: string[];
  saved: SavedViews;
  onClose: () => void;
}) {
  const { config, setConfig, views } = saved;
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef<string | null>(null);
  const [name, setName] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.parentElement!.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [onClose]);

  const hidden = columns.filter(c => !visibleKeys.includes(c.key));
  const byKey = new Map(columns.map(c => [c.key, c]));
  const setColumns = (keys: string[]) => setConfig({ ...config, columns: keys });

  const move = (key: string, to: number) => {
    const keys = visibleKeys.filter(k => k !== key);
    keys.splice(Math.max(0, Math.min(to, keys.length)), 0, key);
    setColumns(keys);
  };

  return (
    <div className="popover customize" ref={ref}>
      <h3>Saved views</h3>
      {views.length === 0 && <p className="muted small">None yet. Set up the table, then name and save it here.</p>}
      <ul className="view-list">
        <li className={saved.activeName ? '' : 'sel'}><button className="link" onClick={() => saved.apply(null)}>Plain view</button></li>
        {views.map(v => (
          <li key={v.id as string} className={saved.activeName === v.name ? 'sel' : ''}>
            <button className="link" onClick={() => saved.apply(v)}>{v.name}</button>
            <span className="spacer" />
            <button className={`icon-btn ${v.is_default ? 'default-view' : ''}`} title={v.is_default ? 'Opens by default. Click to stop.' : 'Open this view by default'}
                    onClick={() => saved.setDefault(v, !v.is_default)}><Star size={14} /></button>
            <button className="icon-btn" title="Delete view" onClick={() => saved.remove(v)}><Trash2 size={14} /></button>
          </li>
        ))}
      </ul>
      <form className="inline-form" onSubmit={async e => {
        e.preventDefault();
        const problem = await saved.save(name);
        setMsg(problem);
        if (!problem) setName('');
      }}>
        <input required placeholder="Name this view" value={name} onChange={e => setName(e.target.value)} />
        <button className="btn">Save</button>
      </form>
      {saved.activeName && (
        <button className="link" onClick={async () => setMsg((await saved.update()) ?? `Updated ${saved.activeName}.`)}>Save changes to {saved.activeName}</button>
      )}
      {msg && <p className="muted small">{msg}</p>}

      <h3>Columns</h3>
      <p className="muted small">Drag to reorder. Drag a column's right edge in the table to resize it.</p>
      <ul className="column-list">
        {visibleKeys.map((k, i) => (
          <li key={k} draggable
              onDragStart={() => { dragging.current = k; }}
              onDragOver={e => e.preventDefault()}
              onDrop={e => { e.preventDefault(); if (dragging.current && dragging.current !== k) move(dragging.current, i); dragging.current = null; }}>
            <GripVertical size={14} className="muted" />
            <label>
              <input type="checkbox" checked disabled={visibleKeys.length === 1} onChange={() => setColumns(visibleKeys.filter(x => x !== k))} /> {byKey.get(k)?.label}
            </label>
            <span className="spacer" />
            <button className="icon-btn" title="Move up" disabled={i === 0} onClick={() => move(k, i - 1)}><ArrowUp size={13} /></button>
            <button className="icon-btn" title="Move down" disabled={i === visibleKeys.length - 1} onClick={() => move(k, i + 1)}><ArrowDown size={13} /></button>
          </li>
        ))}
        {hidden.map(c => (
          <li key={c.key} className="muted">
            <span style={{ width: 14 }} />
            <label><input type="checkbox" checked={false} onChange={() => setColumns([...visibleKeys, c.key])} /> {c.label}</label>
          </li>
        ))}
      </ul>

      <h3>Layout</h3>
      <div className="layout-opts">
        <label>Rows per page{' '}
          <select value={config.pageSize ?? 100} onChange={e => setConfig({ ...config, pageSize: Number(e.target.value) })}>
            {[10, 25, 50, 100].map(n => <option key={n}>{n}</option>)}
          </select>
        </label>
        <label>Freeze columns{' '}
          <select value={config.freeze ?? 0} onChange={e => setConfig({ ...config, freeze: Number(e.target.value) })}>
            {[0, 1, 2].map(n => <option key={n}>{n}</option>)}
          </select>
        </label>
        <label><input type="checkbox" checked={!!config.compact} onChange={e => setConfig({ ...config, compact: e.target.checked })} /> Compact rows</label>
      </div>
      <button className="link" onClick={() => saved.apply(null)}>Reset to default</button>
    </div>
  );
}
