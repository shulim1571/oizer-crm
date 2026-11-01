import DataTable from '../components/DataTable';
import { supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';
import { dateTime } from '../lib/format';

const LIMIT = 2000;

const ACTIONS: Record<string, string> = {
  insert: 'Added', update: 'Edited', delete: 'Deleted', soft_delete: 'Deleted', restore: 'Restored',
  login: 'Signed in', logout: 'Signed out', export: 'Exported',
};

const show = (v: unknown) => (v == null || v === '' ? '(empty)' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** Edits list each field old → new; adds and deletes list the record's values. */
function describe(r: Row): string {
  if (!r.changes) return '';
  const entries = Object.entries(r.changes as Row);
  if (r.action === 'update') return entries.map(([k, v]) => `${k}: ${show(v?.old)} → ${show(v?.new)}`).join('; ');
  if (r.action === 'soft_delete' || r.action === 'restore') return '';
  return entries.map(([k, v]) => `${k}: ${show(v)}`).join('; ');
}

export default function ActivityPage() {
  const q = useQuery(async () => {
    const { data, error } = await supabase.from('activity_log').select('*')
      .order('created_at', { ascending: false }).limit(LIMIT);
    if (error) throw new Error(error.message);
    return data as Row[];
  }, []);

  return (
    <DataTable
      title="Activity Log"
      subtitle={`Latest ${LIMIT.toLocaleString()} entries. This log is permanent and can't be edited.`}
      rows={q.data ?? []}
      loading={q.loading}
      error={q.error}
      columns={[
        { key: 'created_at', label: 'When', render: r => dateTime(r.created_at), value: r => r.created_at, width: 170 },
        { key: 'user_email', label: 'User', width: 200 },
        { key: 'user_role', label: 'Role' },
        { key: 'action', label: 'Action', value: r => ACTIONS[r.action] ?? r.action },
        { key: 'table_name', label: 'Record type' },
        { key: 'record_id', label: 'Record' },
        { key: 'campaign_id', label: 'Campaign' },
        { key: 'changes', label: 'Details', value: describe, width: 360 },
        { key: 'ip', label: 'IP' },
      ]}
    />
  );
}
