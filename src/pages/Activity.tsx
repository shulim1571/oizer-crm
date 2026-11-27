import DataTable from '../components/DataTable';
import { ROLE_LABEL } from '../components/Layout';
import { supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';
import { dateTime } from '../lib/format';
import { describeChanges } from '../components/RecordHistory';

const LIMIT = 2000;

const ACTIONS: Record<string, string> = {
  insert: 'Added', update: 'Edited', delete: 'Deleted', soft_delete: 'Deleted', restore: 'Restored',
  login: 'Signed in', logout: 'Signed out', export: 'Exported',
  login_failed: 'Failed sign-in', account_locked: 'Account locked', unlock_account: 'Unlocked account',
  platform_enter: 'Platform Owner entered', platform_exit: 'Platform Owner left',
};

/** Edits list each field old → new, in words (readiness #46: it showed raw key/value pairs); adds list the values. */
const describe = (r: Row): string => describeChanges(r.action, r.changes as Row | null).join('; ');

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
        { key: 'user_role', label: 'Role', optional: true, value: r => ROLE_LABEL[r.user_role] ?? (r.user_role === 'platform_owner' ? 'Platform Owner' : r.user_role) },
        { key: 'action', label: 'Action', value: r => ACTIONS[r.action] ?? r.action },
        { key: 'table_name', label: 'Record type', optional: true },
        { key: 'record_id', label: 'Record' },
        { key: 'campaign_id', label: 'Campaign', campaignLink: (r: Row) => r.campaign_id },
        { key: 'changes', label: 'Details', long: true, value: describe, width: 360 },
        { key: 'ip', label: 'IP', optional: true },
      ]}
    />
  );
}
