import CrudPage, { campLabel } from '../components/CrudPage';
import AdminLink from '../components/AdminLink';
import { Balance, StatusPill } from '../components/Pill';
import { useAuth } from '../lib/auth';
import { date, dateTime, money, yn } from '../lib/format';
import {
  accountFields, expenseFields, personFields, sourceFields, taskFields, transferFields,
} from '../lib/schemas';

const CAMP = 'id, real_name, campaign_name, friendly_name';

export function ExpensesPage() {
  return (
    <CrudPage
      title="Expenses" noun="Expense"
      table="expenses"
      select={`*, campaigns(${CAMP}), accounts(name)`}
      order={{ column: 'created_at', ascending: false }}
      columns={[
        { key: 'campaign', label: 'Campaign', value: r => campLabel(r.campaigns), width: 200 },
        { key: 'description', label: 'Description' },
        { key: 'payee', label: 'To', width: 160 },
        { key: 'amount', label: 'Amount', render: r => money(r.amount), align: 'right' },
        {
          key: 'account', label: 'Account', value: r => r.accounts?.name,
          render: r => r.account_id && <AdminLink to={`/accounts/${encodeURIComponent(r.account_id)}`}>{r.accounts?.name}</AdminLink>,
        },
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
      title="Transfers" noun="Transfer"
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
      title="Sources" noun="Source"
      table="sources"
      view="source_summary"
      order={{ column: 'donation_count', ascending: false }}
      openPath={r => `/sources/${encodeURIComponent(r.id)}`}
      columns={[
        { key: 'name', label: 'Source', width: 160 },
        { key: 'id', label: 'Key (Row ID)', render: r => <span className="id-tag">{r.id}</span> },
        { key: 'number', label: 'ID' },
        { key: 'donation_count', label: 'Donations', render: r => Number(r.donation_count).toLocaleString(), align: 'right' },
        { key: 'total_amount', label: 'Received', render: r => <b className="num">{money(r.total_amount)}</b>, align: 'right' },
        { key: 'total_fees', label: 'Fees', render: r => money(r.total_fees), align: 'right' },
        { key: 'last_donation_at', label: 'Last donation', render: r => date(r.last_donation_at) },
      ]}
      fields={sourceFields}
    />
  );
}

export function AccountsPage() {
  return (
    <CrudPage
      title="Accounts" noun="Account"
      table="accounts"
      view="account_summary"
      order={{ column: 'name' }}
      openPath={r => `/accounts/${encodeURIComponent(r.id)}`}
      columns={[
        { key: 'name', label: 'Account' },
        { key: 'donations_total', label: 'Donations in', render: r => money(r.donations_total), align: 'right' },
        { key: 'expenses_total', label: 'Expenses out', render: r => money(r.expenses_total), align: 'right' },
        { key: 'uncleared_total', label: 'Uncleared checks', render: r => money(r.uncleared_total), align: 'right' },
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
  return (
    <CrudPage
      title="Managers" noun="Manager"
      table="managers"
      view="manager_summary"
      order={{ column: 'full_name' }}
      openPath={r => `/managers/${encodeURIComponent(r.id)}`}
      columns={[
        personColumns[0],
        { key: 'campaign_count', label: 'Campaigns', render: r => `${r.campaign_count} (${r.active_count} active)`, value: r => r.campaign_count },
        { key: 'raised', label: 'Raised', render: r => money(r.raised), align: 'right' },
        { key: 'balance', label: 'Balance', render: r => <Balance value={r.balance} />, align: 'right' },
        ...personColumns.slice(1),
      ]}
      fields={personFields}
    />
  );
}

export function CollectorsPage() {
  return <CrudPage title="Collectors" noun="Collector" table="collectors" order={{ column: 'full_name' }} columns={personColumns} fields={personFields} />;
}

export function TasksPage() {
  const { role } = useAuth();
  return (
    <CrudPage
      title="Tasks" noun="Task"
      table="tasks"
      select={`*, campaigns(${CAMP}), donors(display_name)`}
      order={{ column: 'created_at', ascending: false }}
      canEdit={role === 'admin' || role === 'manager'}
      defaults={{ status: 'Pending' }}
      groupBy={{ label: "Status", value: r => r.status }}
      columns={[
        { key: 'title', label: 'Task', width: 200 },
        { key: 'campaign', label: 'Campaign', value: r => campLabel(r.campaigns), render: r => campLabel(r.campaigns) },
        { key: 'donor', label: 'Donor', value: r => r.donors?.display_name, render: r => r.donors?.display_name },
        { key: 'assigned_to', label: 'Assigned to' },
        { key: "status", label: "Status", render: r => <StatusPill value={r.status} /> },
        { key: 'due_date', label: 'Due' },
        { key: 'description', label: 'Description' },
        { key: 'created_at', label: 'Created', render: r => dateTime(r.created_at) },
      ]}
      fields={taskFields}
    />
  );
}
