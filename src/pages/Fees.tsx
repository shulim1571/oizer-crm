import PageTabs, { usePageTab } from '../components/PageTabs';
import CrudPage, { campLabel } from '../components/CrudPage';
import type { Field } from '../components/RecordForm';
import { useAuth } from '../lib/auth';
import { accountOptions, campaignOptions, paymentMethodIdOptions } from '../lib/lookups';
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

const FEE_TABS = [['methods', 'Methods & fees'], ['overrides', 'Campaign overrides']] as const;

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
      {tab === 'overrides' && <CrudPage
        title="Campaign Fee Overrides" noun="Override"
        table="campaign_fee_overrides"
        select="*, campaigns(id, internal_name, campaign_name, external_name), payment_methods(name)"
        order={{ column: 'created_at', ascending: false }}
        canEdit={canEdit}
        defaults={{ fee_type: 'none', fee_percent: 0, fee_flat: 0 }}
        columns={[
          { key: 'campaign', label: 'Campaign', value: r => campLabel(r.campaigns), width: 220 },
          { key: 'method', label: 'Method', value: r => r.payment_methods?.name },
          { key: 'fee', label: 'Fee', value: feeText },
        ]}
        fields={overrideFields}
      />}
    </>
  );
}
