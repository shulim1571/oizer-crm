import { useQuery } from '../lib/useQuery';
import { clearLookups } from '../lib/lookups';
import { MachineDialog } from './Machines';
import { lastFirst } from '../lib/nameSort';
import { useNavigate } from 'react-router-dom';
import { RequestPayoutDialog } from './Payouts';
import { Plus } from 'lucide-react';
import CrudPage, { campLabel } from '../components/CrudPage';
import AdminLink from '../components/AdminLink';
import { useState } from 'react';
import { PayoutStatusPill, payoutStatus } from './Payouts';
import { Balance, Pill, StatusPill } from '../components/Pill';
import { supabase, type Row } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { dateTime, money, yn } from '../lib/format';
import {
  accountFields, expenseFields, newPayoutDefaults, personFields, sourceFields,
} from '../lib/schemas';

const CAMP = 'id, internal_name, campaign_name, external_name';

export function ExpensesPage() {
  const { defaultAccountId, isAdmin, canWork } = useAuth();
  const [requesting, setRequesting] = useState(false);
  const nav = useNavigate();
  return (
    <>
    <CrudPage
      title="Payouts" noun="Payout"
      table="expenses"
      select={`*, campaigns(${CAMP}), accounts(name)`}
      order={{ column: 'created_at', ascending: false }}
      columns={[
        { key: 'campaign', label: 'Campaign', campaignLink: (r: Row) => r.campaign_id, value: r => campLabel(r.campaigns), width: 200 },
        { key: 'status', label: 'Status', value: payoutStatus, render: r => <PayoutStatusPill row={r} /> },
        { key: 'payee', label: 'To', width: 160 },
        { key: 'description', label: 'Description', long: true },
        { key: 'amount', label: 'Amount', render: r => money(r.amount), align: 'right' },
        {
          key: 'account', label: 'Account', optional: true, value: r => r.accounts?.name,
          render: r => r.account_id && <AdminLink to={`/accounts/${encodeURIComponent(r.account_id)}`}>{r.accounts?.name}</AdminLink>,
        },
        { key: 'method', label: 'Method' },
        { key: 'memo', label: 'Memo', long: true, optional: true },
        { key: 'check_number', label: 'Check Number', optional: true },
        { key: 'reference', label: 'Reference', optional: true },
        { key: 'cleared', label: 'Cleared', render: r => yn(r.cleared) },
        { key: 'notes', label: 'Notes', long: true, optional: true },
        { key: 'created_at', label: 'Timestamp', render: r => dateTime(r.created_at), width: 170 },
      ]}
      fields={expenseFields}
      defaults={{ account_id: defaultAccountId, ...newPayoutDefaults() }}
      // Admins enter payouts directly ("New payout"); fundraisers ask the office for one.
      extraActions={!isAdmin && canWork && (
        <button className="btn primary" onClick={() => setRequesting(true)}><Plus size={16} /> New payout request</button>
      )}
    />
    {requesting && (
      <RequestPayoutDialog onClose={() => setRequesting(false)}
        onSaved={() => { setRequesting(false); nav('/payout-requests'); }} />
    )}
    </>
  );
}

/**
 * Sources and Donary machines in one list (Shulim, 2026-11-13): a Donary machine is a mobile source. A source marked
 * as one has its machine (number, Donary ID, the campaign it's set to remotely, its bookings to fundraisers by date),
 * opened with Machine…; Make Donary machine turns any source into one, and retiring the machine turns it back.
 */
export function SourcesPage() {
  const [version, setVersion] = useState(0);
  const [openMachine, setOpenMachine] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const machines = useQuery(async () => {
    const { data, error: e } = await supabase.from('machines').select('id, nickname, donary_id, source_id, campaign_id, active, campaigns(internal_name, campaign_name, external_name)');
    if (e) throw new Error(e.message);
    return new Map(((data ?? []) as Row[]).filter(m => m.source_id).map(m => [String(m.source_id), m]));
  }, [version]);
  const bySource = (machines.data as Map<string, Row> | null) ?? new Map<string, Row>();
  const machineOf = (r: Row) => bySource.get(String(r.id));
  async function makeMachine(r: Row) {
    // The Donary ID is the device key donations arrive with: the source's name when it looks like one (DP_13012), else its key.
    const suggested = /^dp[\s_-]?\d+$/i.test(String(r.name ?? '').trim()) ? String(r.name).trim() : String(r.id);
    const donaryId = prompt(`Make "${r.name}" a Donary machine. Donary machine ID:`, suggested);
    if (donaryId === null) return;
    setError(null);
    const { data, error: e } = await supabase.rpc('set_source_donary_machine', { p_source: r.id, p_on: true, p_donary_id: donaryId.trim() || null });
    if (e) return setError(e.message);
    clearLookups();
    setVersion(v => v + 1);
    setOpenMachine(data as string);
  }
  const machineCell = (r: Row) => {
    const m = machineOf(r);
    if (m) {
      return (
        <button type="button" className="link" onClick={e => { e.stopPropagation(); setOpenMachine(String(m.id)); }}>
          <Pill tone={m.active ? 'green' : ''}>{m.active ? `Machine ${m.nickname}` : `Machine ${m.nickname} (retired)`}</Pill>
        </button>
      );
    }
    return <button type="button" className="link small" onClick={e => { e.stopPropagation(); void makeMachine(r); }}>Make Donary machine</button>;
  };
  return (
    <>
      {error && <div className="error">{error}</div>}
      <CrudPage
        key={version}
        title="Sources" noun="Source"
        table="sources"
        view="source_summary"
        order={{ column: 'donation_count', ascending: false }}
        openPath={r => `/sources/${encodeURIComponent(r.id)}`}
        groupBy={{ label: 'Type', value: r => (machineOf(r)?.active ? 'Donary machines' : 'Other sources') }}
        columns={[
          { key: 'name', label: 'Source', width: 160 },
          { key: 'machine', label: 'Donary machine', width: 170, value: r => { const m = machineOf(r); return m ? `Machine ${m.nickname}${m.active ? '' : ' (retired)'}` : ''; }, render: machineCell },
          { key: 'machine_campaign', label: 'Machine set to', campaignLink: (r: Row) => machineOf(r)?.campaign_id, width: 200,
            value: r => { const m = machineOf(r); if (!m?.active) return ''; return m.campaign_id ? `${m.campaigns?.internal_name || m.campaigns?.campaign_name || m.campaigns?.external_name || ''} - ${m.campaign_id}` : 'Unassigned'; } },
          { key: 'id', label: 'Key (Row ID)', render: r => <span className="id-tag">{r.id}</span> },
          { key: 'number', label: 'ID' },
          { key: 'donation_count', label: 'Donations', render: r => Number(r.donation_count).toLocaleString(), align: 'right' },
          { key: 'total_amount', label: 'Received', render: r => <b className="num">{money(r.total_amount)}</b>, align: 'right' },
          { key: 'total_fees', label: 'Fees', render: r => money(r.total_fees), align: 'right' },
          { key: 'last_donation_at', label: 'Last donation', render: r => dateTime(r.last_donation_at) },
        ]}
        fields={sourceFields}
      />
      {openMachine && <MachineDialog id={openMachine} onClose={() => setOpenMachine(null)} onChanged={() => { clearLookups(); setVersion(v => v + 1); }} />}
    </>
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
        { key: 'notes', label: 'Notes' },
      ]}
      fields={accountFields}
    />
    </>
  );
}

const personColumns = [
  { key: 'full_name', label: 'Name', width: 200, sortValue: (r: Record<string, unknown>) => lastFirst(r, 'full_name') },
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


