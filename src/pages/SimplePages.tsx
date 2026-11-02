import CrudPage, { campLabel } from '../components/CrudPage';
import AdminLink from '../components/AdminLink';
import { useState } from 'react';
import { PayoutStatusPill, payoutStatus } from './Payouts';
import { Balance, Pill, StatusPill } from '../components/Pill';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { dateTime, money, yn } from '../lib/format';
import {
  accountFields, expenseFields, personFields, sourceFields,
} from '../lib/schemas';

const CAMP = 'id, internal_name, campaign_name, external_name';

export function ExpensesPage() {
  const { defaultAccountId } = useAuth();
  return (
    <CrudPage
      title="Payouts" noun="Payout"
      table="expenses"
      select={`*, campaigns(${CAMP}), accounts(name)`}
      order={{ column: 'created_at', ascending: false }}
      columns={[
        { key: 'campaign', label: 'Campaign', value: r => campLabel(r.campaigns), width: 200 },
        { key: 'status', label: 'Status', value: payoutStatus, render: r => <PayoutStatusPill row={r} /> },
        { key: 'payee', label: 'To', width: 160 },
        { key: 'description', label: 'Description' },
        { key: 'amount', label: 'Amount', render: r => money(r.amount), align: 'right' },
        {
          key: 'account', label: 'Account', value: r => r.accounts?.name,
          render: r => r.account_id && <AdminLink to={`/accounts/${encodeURIComponent(r.account_id)}`}>{r.accounts?.name}</AdminLink>,
        },
        { key: 'method', label: 'Method' },
        { key: 'memo', label: 'Memo' },
        { key: 'check_number', label: 'Check Number' },
        { key: 'reference', label: 'Reference' },
        { key: 'cleared', label: 'Cleared', render: r => yn(r.cleared) },
        { key: 'notes', label: 'Notes' },
        { key: 'created_at', label: 'Timestamp', render: r => dateTime(r.created_at), width: 170 },
      ]}
      fields={expenseFields}
      defaults={{ account_id: defaultAccountId }}
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
        { key: 'last_donation_at', label: 'Last donation', render: r => dateTime(r.last_donation_at) },
      ]}
      fields={sourceFields}
    />
  );
}

export function AccountsPage() {
  const { defaultAccountId, permissions, refresh } = useAuth();
  const [error, setError] = useState<string | null>(null);
  async function makeDefault(id: string, name: string) {
    if (!confirm(`Make ${name} the default bank account? Payments go here unless their campaign or payment method says otherwise.`)) return;
    setError(null);
    const { error: e } = await supabase.rpc('set_default_account', { p_account: id });
    if (e) return setError(e.message);
    await refresh();
  }
  return (
    <>
    {error && <div className="error">{error}</div>}
    <CrudPage
      title="Accounts" noun="Account"
      table="accounts"
      view="account_summary"
      order={{ column: 'name' }}
      openPath={r => `/accounts/${encodeURIComponent(r.id)}`}
      columns={[
        {
          key: 'name', label: 'Account',
          render: r => (
            <>
              {r.name}
              {r.id === defaultAccountId && <> <Pill tone="green">Default</Pill></>}
              {r.id !== defaultAccountId && permissions.includes('change_default_bank') && (
                <> <button type="button" className="link" onClick={e => { e.stopPropagation(); void makeDefault(r.id, r.name); }}>Set default</button></>
              )}
            </>
          ),
        },
        { key: 'donations_total', label: 'Donations in', render: r => money(r.donations_total), align: 'right' },
        { key: 'expenses_total', label: 'Expenses out', render: r => money(r.expenses_total), align: 'right' },
        { key: 'uncleared_total', label: 'Uncleared checks', render: r => money(r.uncleared_total), align: 'right' },
        { key: 'filter_checks', label: 'Filter Checks', render: r => yn(r.filter_checks) },
        { key: 'notes', label: 'Notes' },
      ]}
      fields={accountFields}
    />
    </>
  );
}

const personColumns = [
  { key: 'full_name', label: 'Name', width: 200 },
  { key: 'phone', label: 'Phone' },
  { key: 'email', label: 'Email' },
  { key: 'notes', label: 'Notes' },
  { key: 'created_at', label: 'Created', render: (r: Record<string, unknown>) => dateTime(r.created_at) },
];

const FUNDRAISER_STATUS: Record<string, string> = { active: 'Active', suspended: 'Suspended', deactivated: 'Deactivated' };

export function ManagersPage() {
  return (
    <CrudPage
      title="Fundraisers" noun="Fundraiser"
      table="managers"
      view="manager_summary"
      order={{ column: 'full_name' }}
      openPath={r => `/managers/${encodeURIComponent(r.id)}`}
      columns={[
        personColumns[0],
        { key: 'status', label: 'Status', value: r => FUNDRAISER_STATUS[r.status], render: r => <StatusPill value={FUNDRAISER_STATUS[r.status]} /> },
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

