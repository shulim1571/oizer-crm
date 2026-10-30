import { useState, type ReactNode } from 'react';
import { Plus } from 'lucide-react';
import DataTable, { type Column, type GroupBy } from './DataTable';
import RecordForm, { type Field } from './RecordForm';
import { fetchAll, supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';
import { useAuth } from '../lib/auth';

interface Props {
  title: string;
  /** Singular name for buttons and form titles; defaults to the title. */
  noun?: string;
  table: string;
  select?: string;
  order?: { column: string; ascending?: boolean };
  columns: Column[];
  fields: Field[];
  groupBy?: GroupBy;
  /** Who may add/edit; defaults to admins only. */
  canEdit?: boolean;
  defaults?: Row;
  pk?: string;
  extraActions?: ReactNode;
}

export default function CrudPage(p: Props) {
  const { isAdmin } = useAuth();
  const canEdit = p.canEdit ?? isAdmin;
  const [editing, setEditing] = useState<Row | null | undefined>(undefined);

  const { data, error, loading, setData } = useQuery(
    () => fetchAll((a, b) => {
      let q = supabase.from(p.table).select(p.select ?? '*');
      if (p.order) q = q.order(p.order.column, { ascending: p.order.ascending ?? true });
      return q.range(a, b) as unknown as PromiseLike<{ data: Row[] | null; error: { message: string } | null }>;
    }),
    [p.table, p.select],
  );

  const pk = p.pk ?? 'id';
  const onSaved = async (row: Row) => {
    setEditing(undefined);
    // Re-read the row so embedded relations (campaign names etc.) are filled in.
    if (row._deleted) return setData(d => (d ?? []).filter(r => r[pk] !== row[pk]));
    const { data: fresh } = await supabase.from(p.table).select(p.select ?? '*').eq(pk, row[pk]).single();
    const full = (fresh as Row | null) ?? row;
    setData(d => {
      const list = d ?? [];
      return list.some(r => r[pk] === row[pk]) ? list.map(r => (r[pk] === row[pk] ? full : r)) : [full, ...list];
    });
  };

  return (
    <>
      <DataTable
        title={p.title}
        rows={data ?? []}
        loading={loading}
        error={error}
        columns={p.columns}
        groupBy={p.groupBy}
        onOpen={canEdit ? r => setEditing(r) : undefined}
        actions={
          <>
            {p.extraActions}
            {canEdit && (
              <button className="btn primary" onClick={() => setEditing(null)}><Plus size={16} /> New {(p.noun ?? p.title).toLowerCase()}</button>
            )}
          </>
        }
      />
      {editing !== undefined && (
        <RecordForm
          table={p.table}
          pk={p.pk}
          title={editing ? `Edit ${(p.noun ?? p.title).toLowerCase()}` : `New ${(p.noun ?? p.title).toLowerCase()}`}
          fields={p.fields}
          record={editing}
          defaults={p.defaults}
          onClose={() => setEditing(undefined)}
          onSaved={onSaved}
          allowDelete={isAdmin}
        />
      )}
    </>
  );
}

export const campLabel = (c: Row | null | undefined) =>
  c ? `${c.real_name || c.campaign_name || c.friendly_name || ''} - ${c.id}` : '';
