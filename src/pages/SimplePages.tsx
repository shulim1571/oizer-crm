import CrudPage, { campLabel } from '../components/CrudPage';
import { useAuth } from '../lib/auth';
import { dateTime, money, yn } from '../lib/format';
import {
  accountFields, expenseFields, personFields, sourceFields, taskFields, transferFields,
} from '../lib/schemas';

const CAMP = 'id, real_name, campaign_name, friendly_name';

export function ExpensesPage() {
  return (
    <CrudPage
      title="Expense"
      table="expenses"
      select={`*, campaigns(${CAMP}), accounts(name)`}
      order={{ column: 'created_at', ascending: false }}
      columns={[
        { key: 'campaign', label: 'Campaign', value: r => campLabel(r.campaigns), width: 200 },
        { key: 'description', label: 'Description' },
        { key: 'payee', label: 'To', width: 160 },
        { key: 'amount', label: 'Amount', render: r => money(r.amount), align: 'right' },
        { key: 'account', label: 'Account', value: r => r.accounts?.name },
        { key: 'method', label: 'Method' },
        { key: 'memo', label: 'Memo' },
        { key: 'check_number', label: 'Check Number' },
        { key: 'cleared', label: 'Cleared', render: r => yn(r.cleared) },
        { key: 'notes', label: 'Notes' },
        { key: 'created_at', label: 'Timestamp', render: r => dateTime(r.created_at), width: 170 },
      ]}
      fields={expenseFields}
      defaults={{ account_id: '8d4b5fbe' }}
    />
  );
}

export function TransfersPage() {
  return (
    <CrudPage
      title="Transfer"
      table="transfers"
      select={`*, from:campaigns!transfers_from_campaign_id_fkey(${CAMP}), to:campaigns!transfers_to_campaign_id_fkey(${CAMP})`}
      order={{ column: 'created_at', ascending: false }}
      columns={[
        { key: 'amount', label: 'Amount', render: r => money(r.amount), align: 'right' },
        { key: 'from', label: 'From', value: r => campLabel(r.from), render: r => campLabel(r.from) },
        { key: 'to', label: 'To', value: r => campLabel(r.to), render: r => campLabel(r.to) },
        { key: 'description', label: 'Description' },
        { key: 'notes', label: 'Notes' },
        { key: 'created_by', label: 'Created By' },
        { key: 'created_at', label: 'Timestamp', render: r => dateTime(r.created_at) },
      ]}
      fields={transferFields}
    />
  );
}

export function SourcesPage() {
  return (
    <CrudPage
      title="Source"
      table="sources"
      order={{ column: 'name' }}
      columns={[
        { key: 'name', label: 'Source' },
        { key: 'number', label: 'ID' },
        { key: 'id', label: 'Key' },
      ]}
      fields={sourceFields}
    />
  );
}

export function AccountsPage() {
  return (
    <CrudPage
      title="Account"
      table="accounts"
      order={{ column: 'name' }}
      columns={[
        { key: 'name', label: 'Account' },
        { key: 'filter_checks', label: 'Filter Checks', render: r => yn(r.filter_checks) },
        { key: 'notes', label: 'Notes' },
      ]}
      fields={accountFields}
    />
  );
}

const personColumns = [
  { key: 'full_name', label: 'Name', width: 200 },
  { key: 'phone', label: 'Phone' },
  { key: 'email', label: 'Email' },
  { key: 'notes', label: 'Notes' },
  { key: 'created_at', label: 'Created', render: (r: Record<string, unknown>) => dateTime(r.created_at) },
];

export function ManagersPage() {
  return <CrudPage title="Manager" table="managers" order={{ column: 'full_name' }} columns={personColumns} fields={personFields} />;
}

export function CollectorsPage() {
  return <CrudPage title="Collector" table="collectors" order={{ column: 'full_name' }} columns={personColumns} fields={personFields} />;
}

export function TasksPage() {
  const { role } = useAuth();
  return (
    <CrudPage
      title="Task"
      table="tasks"
      select={`*, campaigns(${CAMP}), donors(display_name)`}
      order={{ column: 'created_at', ascending: false }}
      canEdit={role === 'admin' || role === 'manager'}
      defaults={{ status: 'Pending' }}
      groupBy={{ value: r => r.status }}
      columns={[
        { key: 'title', label: 'Task', width: 200 },
        { key: 'campaign', label: 'Campaign', value: r => campLabel(r.campaigns), render: r => campLabel(r.campaigns) },
        { key: 'donor', label: 'Donor', value: r => r.donors?.display_name, render: r => r.donors?.display_name },
        { key: 'assigned_to', label: 'Assigned to' },
        { key: 'status', label: 'Status' },
        { key: 'due_date', label: 'Due' },
        { key: 'description', label: 'Description' },
        { key: 'created_at', label: 'Created', render: r => dateTime(r.created_at) },
      ]}
      fields={taskFields}
    />
  );
}
