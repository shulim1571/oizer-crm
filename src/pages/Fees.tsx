import PageTabs, { usePageTab } from '../components/PageTabs';
import CrudPage, { campLabel } from '../components/CrudPage';
import type { Field } from '../components/RecordForm';
import { useAuth } from '../lib/auth';
import { accountOptions, campaignOptions, paymentMethodIdOptions, paymentMethodNameOptions } from '../lib/lookups';
import { fetchAll, supabase } from '../lib/supabase';
import type { Row } from '../lib/supabase';

const FEE_TYPES = [['none', 'None'], ['flat', 'Flat $'], ['percent', '% rate'], ['percent_flat', '% rate + flat $']].map(([value, label]) => ({ value, label }));
const CATEGORIES = ['Gateway', 'Manual', 'DAF', 'Voucher', 'Webhook', 'Custom'].map(v => ({ value: v, label: v }));

const feeFields: Field[] = [
  { name: 'fee_type', label: 'Fee type', type: 'select', options: FEE_TYPES, required: true },
  { name: 'fee_percent', label: '% rate', type: 'number' },
  { name: 'fee_flat', label: 'Flat $', type: 'number' },
];

const methodFields: Field[] = [
  { name: 'name', label: 'Method', required: true },
  { name: 'category', label: 'Category', type: 'select', options: CATEGORIES, required: true },
  ...feeFields,
  { name: 'account_id', label: 'Bank account', type: 'select', options: accountOptions, help: 'Payments by this method go here unless their campaign has its own. Empty means the default.' },
  { name: 'is_check', label: 'Is a check', type: 'checkbox', help: 'Shows the check number, date and delivery on gifts by this method.' },
  { name: 'receipt_allowed', label: 'Receipts allowed', type: 'checkbox' },
  { name: 'active', label: 'Active', type: 'checkbox', help: 'Inactive methods stop being offered; past records keep them.' },
];

const overrideFields: Field[] = [
  { name: 'campaign_id', label: 'Campaign', type: 'search', options: campaignOptions, required: true },
  { name: 'method_id', label: 'Method', type: 'select', options: paymentMethodIdOptions, required: true },
  ...feeFields,
];

const feeText = (r: Row) => {
  switch (r.fee_type) {
    case 'flat': return `$${Number(r.fee_flat).toFixed(2)}`;
    case 'percent': return `${Number(r.fee_percent)}%`;
    case 'percent_flat': return `${Number(r.fee_percent)}% + $${Number(r.fee_flat).toFixed(2)}`;
    default: return 'None';
  }
};

const PROCESSORS = [['sola', 'Sola (Cardknox), incl. cards taken in the app'], ['elevon', 'Elevon (Cartis)'], ['donary', 'Donary']].map(([value, label]) => ({ value, label }));
const processorFields: Field[] = [
  { name: 'processor', label: 'Processor', type: 'select', options: PROCESSORS, required: true },
  { name: 'method_id', label: 'Method', type: 'select', options: paymentMethodIdOptions, required: true },
  ...feeFields,
];

// Readiness #14: a Sola card gift and an Elevon card gift can carry different rates. Order: a campaign's own
// override, then the processor's rate for the method, then the method's rate.

const aliasFields: Field[] = [
  { name: 'alias', label: 'Name as it comes in', required: true, help: 'Exactly as Donary, Sola or an import sends it; capitals don\'t matter' },
  { name: 'method_name', label: 'Map to method', type: 'select', options: paymentMethodNameOptions,
    help: 'Gifts that come in with this name are saved under this method, and gifts already on file with it are moved (their fees stay as recorded). Leave empty if it isn\'t a way of giving.' },
  { name: 'not_a_method', label: 'Not a way of giving (a payout or transfer)', type: 'checkbox' },
];

const FEE_TABS = [['methods', 'Methods & fees'], ['processors', 'Processor rates'], ['overrides', 'Campaign overrides'], ['aliases', 'Method aliases']] as const;

export default function FeesPage() {
  const { permissions } = useAuth();
  const canEdit = permissions.includes('configure_fees');
  const [tab, setTab] = usePageTab(FEE_TABS.map(([k]) => k));
  return (
    <>
      <div className="page-tabs-wrap"><PageTabs tabs={FEE_TABS} value={tab} onChange={setTab} /></div>
      {tab === 'methods' && <CrudPage
        title="Payment Methods & Fees" noun="Payment method"
        table="payment_methods"
        order={{ column: 'name' }}
        canEdit={canEdit}
        noDelete
        defaults={{ category: 'Custom', fee_type: 'none', fee_percent: 0, fee_flat: 0, active: true, receipt_allowed: true }}
        columns={[
          { key: 'name', label: 'Method', width: 180 },
          { key: 'category', label: 'Category' },
          { key: 'fee', label: 'Fee', value: feeText },
          { key: 'receipt_allowed', label: 'Receipts', value: r => (r.receipt_allowed ? 'Yes' : 'No') },
          { key: 'active', label: 'Active', value: r => (r.active ? 'Yes' : 'No') },
        ]}
        fields={methodFields}
      />}
      {tab === 'processors' && <CrudPage
        title="Processor Rates" noun="Processor rate"
        table="processor_fee_rules"
        select="*, payment_methods(name)"
        order={{ column: 'created_at', ascending: false }}
        canEdit={canEdit}
        defaults={{ processor: 'sola', fee_type: 'percent_flat', fee_percent: 0, fee_flat: 0 }}
        extraActions={<span className="muted small">Used instead of the method's own rate for gifts through that processor. A campaign override still comes first.</span>}
        columns={[
          { key: 'processor', label: 'Processor', value: r => PROCESSORS.find(p => p.value === r.processor)?.label ?? r.processor, width: 260 },
          { key: 'method', label: 'Method', value: r => r.payment_methods?.name },
          { key: 'fee', label: 'Fee', value: feeText },
        ]}
        fields={processorFields}
      />}
      {/* Method aliases (readiness #57; live 2026-11-17, Shulim): names from webhooks and imports mapped to a method. */}
      {tab === 'aliases' && <CrudPage
        title="Method Aliases" noun="Alias"
        table="payment_method_aliases"
        order={{ column: 'alias' }}
        canEdit={canEdit}
        defaults={{ not_a_method: false }}
        extraActions={<span className="muted small">Map a payment method name that Donary, Sola or an import sends to one of your methods. Saving an alias moves the gifts already on file with that name (their fees stay as recorded) and maps new ones as they arrive, with the method's fee. A <b>Suggestion</b> only groups the dashboard chart until you open it and save.</span>}
        columns={[
          { key: 'alias', label: 'Name as it comes in', width: 240 },
          { key: 'method_name', label: 'Mapped to', value: r => (r.not_a_method ? 'Not a way of giving' : r.method_name) },
          { key: 'applied_at', label: 'Status', value: r => (r.not_a_method ? 'Chart only' : r.applied_at ? `In use since ${new Date(r.applied_at).toLocaleDateString()}${r.applied_by ? ` · ${r.applied_by}` : ''}` : 'Suggestion') },
        ]}
        fields={aliasFields}
      />}
      {tab === 'overrides' && <CrudPage
        title="Campaign Fee Overrides" noun="Override"
        table="campaign_fee_overrides"
        select="*, campaigns(id, internal_name, campaign_name, external_name), payment_methods(name)"
        order={{ column: 'created_at', ascending: false }}
        canEdit={canEdit}
        defaults={{ fee_type: 'none', fee_percent: 0, fee_flat: 0 }}
        columns={[
          { key: 'campaign', label: 'Campaign', campaignLink: (r: Row) => r.campaign_id, value: r => campLabel(r.campaigns), width: 220 },
          { key: 'method', label: 'Method', value: r => r.payment_methods?.name },
          { key: 'fee', label: 'Fee', value: feeText },
        ]}
        fields={overrideFields}
      />}
    </>
  );
}
