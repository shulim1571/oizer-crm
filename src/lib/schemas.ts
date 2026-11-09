import type { Field } from '../components/RecordForm';
import {
  CAMPAIGN_STATUSES, DONATION_STATUSES, DONATION_TYPES, payeeOptions, payoutMethodOptions, paymentMethodOptions, voucherIssuerOptions, TASK_STATUSES, accountOptions, campaignOptions,
  collectorOptions, donorOptions, managerOptions, sourceOptions,
} from './lookups';

const create = {
  campaign: () => ({ noun: 'campaign', table: 'campaigns', fields: newCampaignFields, defaults: { status: 'active' } }),
  fundraiser: () => ({ noun: 'fundraiser', table: 'managers', fields: personFields }),
  donor: () => ({ noun: 'donor', table: 'donors', fields: donorFields }),
  collector: () => ({ noun: 'collector', table: 'collectors', fields: personFields }),
  source: () => ({ noun: 'source', table: 'sources', fields: sourceFields }),
  account: () => ({ noun: 'account', table: 'accounts', fields: accountFields }),
  payee: () => ({ noun: 'payee', table: 'payees', fields: payeeFields }),
};

export const campaignFields: Field[] = [
  { name: 'internal_name', label: 'Internal Name', required: true, help: 'Only seen inside the portal' },
  { name: 'external_name', label: 'External Name', help: 'What donors see. Uses the internal name if left empty.' },
  { name: 'campaign_name', label: 'Other Name' },
  { name: 'manager_id', label: 'Primary Fundraiser', type: 'search', options: managerOptions, create: create.fundraiser },
  { name: 'sub_manager_ids', label: 'Secondary Fundraisers', type: 'multi', options: managerOptions, create: create.fundraiser },
  { name: 'email', label: 'Email', type: 'email' },
  { name: 'phone', label: 'Phone' },
  { name: 'goal', label: 'Goal', type: 'number' },
  { name: 'account_id', label: 'Bank account', type: 'select', options: accountOptions, help: 'Leave empty to use the payment method\'s account, then the default. Sub-campaigns follow this.' },
  { name: 'payment_link', label: 'Payment Link' },
  { name: 'pin', label: 'Phone PIN', help: '4 to 8 digits. Lets anyone with it hear this campaign’s balance by text or phone.' },
  { name: 'exchange', label: 'Exchange', type: 'checkbox' },
  { name: 'featured', label: 'Featured', type: 'checkbox' },
  { name: 'notes', label: 'Notes', type: 'textarea' },
];

export const newCampaignFields: Field[] = [
  ...campaignFields,
  { name: 'status', label: 'Status', type: 'select', options: CAMPAIGN_STATUSES, required: true },
];

export const donationFields: Field[] = [
  { name: 'campaign_id', label: 'Campaign', type: 'search', options: campaignOptions, required: true, create: create.campaign },
  { name: 'type', label: 'Type', type: 'select', options: DONATION_TYPES, required: true },
  { name: 'status', label: 'Status', type: 'select', options: DONATION_STATUSES, required: true },
  { name: 'amount', label: 'Amount', type: 'number', required: true },
  { name: 'payment_method', label: 'Payment Method', type: 'select', options: paymentMethodOptions, freeText: true },
  { name: 'check_number', label: 'Check #' },
  { name: 'post_dated', label: 'Post-dated check', type: 'checkbox' },
  { name: 'check_date', label: 'Check date', type: 'date', help: 'A later date keeps it out of the balance until then' },
  { name: 'anonymous', label: 'Anonymous', type: 'checkbox' },
  { name: 'donor_id', label: 'Donor', type: 'search', options: donorOptions, create: create.donor },
  { name: 'name', label: 'Name on payment' },
  { name: 'phone', label: 'Phone' },
  { name: 'email', label: 'Email', type: 'email' },
  { name: 'collector_id', label: 'Collector', type: 'search', options: collectorOptions, create: create.collector },
  { name: 'source', label: 'Source', type: 'select', options: sourceOptions, create: create.source },
  { name: 'account_id', label: 'Account', type: 'select', options: accountOptions, create: create.account, help: 'Leave empty to route it automatically' },
  { name: 'fee', label: 'Fee', type: 'number', help: "Leave empty to use the method's fee. Enter 0 to waive it." },
  { name: 'manual_fee', label: 'Manual Fee', type: 'number' },
  { name: 'batch_id', label: 'Batch ID / Voucher #' },
  { name: 'funded', label: 'Funded', type: 'number', help: 'Batch rows: amount actually received' },
  { name: 'batch_status', label: 'Batch Status', type: 'select', options: ['Open', 'Complete'].map(v => ({ value: v, label: v })) },
  { name: 'batch_pending', label: 'Batch Pending', type: 'number' },
  { name: 'delivered', label: 'Delivered', type: 'checkbox' },
  { name: 'created_at', label: 'Timestamp', type: 'datetime' },
  { name: 'notes', label: 'Notes', type: 'textarea' },
];

/** What a fundraiser with the override fills in. It always waits for an admin. */
export const fundraiserDonationFields: Field[] = [
  { name: 'amount', label: 'Amount', type: 'number', required: true },
  { name: 'payment_method', label: 'Payment Method', type: 'select', options: paymentMethodOptions, freeText: true, required: true },
  { name: 'name', label: 'Donor name' },
  { name: 'phone', label: 'Phone' },
  { name: 'check_number', label: 'Check #' },
  { name: 'notes', label: 'Notes', type: 'textarea' },
];

const pledgeWho: Field[] = [
  { name: 'donor_id', label: 'Donor', type: 'search', options: donorOptions, help: 'Payments match automatically only when a donor is linked' },
  { name: 'name', label: 'Name, if not linked' },
  { name: 'phone', label: 'Phone' },
];

export const pledgeFields: Field[] = [
  { name: 'campaign_id', label: 'Campaign', type: 'search', options: campaignOptions, required: true },
  ...pledgeWho,
  { name: 'amount', label: 'Pledge amount', type: 'number', required: true },
  { name: 'date_pledged', label: 'Date pledged', type: 'date', required: true },
  { name: 'expected_date', label: 'Expected payment date', type: 'date' },
  { name: 'notes', label: 'Notes', type: 'textarea' },
];

const FREQUENCIES = ['weekly', 'monthly', 'quarterly', 'annually'].map(v => ({ value: v, label: v[0].toUpperCase() + v.slice(1) }));

export const recurringPledgeFields: Field[] = [
  { name: 'campaign_id', label: 'Campaign', type: 'search', options: campaignOptions, required: true },
  ...pledgeWho,
  { name: 'installment_amount', label: 'Installment amount', type: 'number', required: true },
  { name: 'frequency', label: 'Frequency', type: 'select', options: FREQUENCIES, required: true },
  { name: 'start_date', label: 'First installment', type: 'date', required: true },
  { name: 'installment_count', label: 'Number of installments', type: 'number', help: 'Leave empty for open-ended' },
  { name: 'date_pledged', label: 'Date pledged', type: 'date', required: true },
  { name: 'notes', label: 'Notes', type: 'textarea' },
];

export const pledgeEditFields: Field[] = pledgeFields;
/** The schedule itself changes through Change schedule, so it's kept in step with its installments. */
export const recurringPledgeEditFields: Field[] = [...pledgeWho, { name: 'date_pledged', label: 'Date pledged', type: 'date', required: true }, { name: 'notes', label: 'Notes', type: 'textarea' }];

export const voucherFields: Field[] = [
  { name: 'issuer', label: 'Voucher issuer', type: 'select', options: voucherIssuerOptions, required: true },
  { name: 'issuer_number', label: 'Issuer voucher / batch #' },
  { name: 'campaign_id', label: 'Campaign', type: 'search', options: campaignOptions, required: true },
  { name: 'donor_id', label: 'Donor', type: 'search', options: donorOptions },
  { name: 'name', label: 'Donor name, if not linked' },
  { name: 'face_value', label: 'Face value', type: 'number', required: true },
  { name: 'fee_type', label: 'Fee type', type: 'select', options: [['flat', 'Flat $'], ['percent', '% rate'], ['none', 'None']].map(([value, label]) => ({ value, label })), help: "Leave empty to use the issuer's rate from Methods & Fees. Set once: it can't change after funds arrive." },
  { name: 'fee_percent', label: '% rate', type: 'number' },
  { name: 'fee_flat', label: 'Flat $ per funding', type: 'number' },
  { name: 'submission', label: 'Submission', type: 'select', options: [['online', 'Submitted online'], ['mailed', 'Mailed in']].map(([value, label]) => ({ value, label })), required: true },
  { name: 'account_number', label: 'Account #', help: 'Only for a damaged voucher that is mailed in' },
  { name: 'date_received', label: 'Date received', type: 'date', required: true },
  { name: 'expected_date', label: 'Expected funding date', type: 'date' },
  { name: 'notes', label: 'Notes', type: 'textarea' },
];

/** Admins can also make a task on a fundraiser's behalf, which then belongs to that fundraiser. */
export const adminTaskFields = (): Field[] => [
  ...taskFields,
  { name: 'owner_manager_id', label: 'For fundraiser', type: 'search', options: managerOptions, help: 'Empty keeps it shared on the campaign' },
];

/** Admin notes aren't for fundraisers. */
export const fundraiserDonorFields = (): Field[] => donorFields.filter(f => f.name !== 'notes');

export const payeeFields: Field[] = [
  { name: 'name', label: 'Name', required: true },
  { name: 'phone', label: 'Phone' },
  { name: 'email', label: 'Email', type: 'email' },
  { name: 'address', label: 'Address', type: 'textarea' },
  { name: 'preferred_method', label: 'Preferred payout method', type: 'select', options: payoutMethodOptions },
  { name: 'notes', label: 'Notes', type: 'textarea' },
];

export const expenseFields: Field[] = [
  { name: 'campaign_id', label: 'Campaign', type: 'search', options: campaignOptions, required: true, create: create.campaign },
  { name: 'payee_id', label: 'Payee', type: 'search', options: payeeOptions, create: create.payee },
  { name: 'amount', label: 'Amount', type: 'number', required: true },
  { name: 'method', label: 'Method', type: 'select', options: payoutMethodOptions },
  { name: 'scheduled_for', label: 'Process on', type: 'date', help: 'A later date schedules it. It leaves the balance now and comes back to the Task Sheet on the day.' },
  { name: 'reference', label: 'Reference', help: 'Zelle or ACH reference, wire confirmation number' },
  { name: 'account_id', label: 'Account', type: 'select', options: accountOptions, create: create.account },
  { name: 'check_number', label: 'Check Number' },
  { name: 'memo', label: 'Memo' },
  { name: 'description', label: 'Description' },
  { name: 'cleared', label: 'Cleared', type: 'checkbox' },
  { name: 'created_at', label: 'Timestamp', type: 'datetime' },
  { name: 'notes', label: 'Notes', type: 'textarea' },
];

export const transferFields: Field[] = [
  { name: 'from_campaign_id', label: 'From campaign', type: 'search', options: campaignOptions, create: create.campaign },
  { name: 'to_campaign_id', label: 'To campaign', type: 'search', options: campaignOptions, required: true, create: create.campaign },
  { name: 'amount', label: 'Amount', type: 'number', required: true },
  { name: 'description', label: 'Description' },
  { name: 'created_at', label: 'Timestamp', type: 'datetime' },
  { name: 'notes', label: 'Notes', type: 'textarea' },
];

/** A posted transfer's money can't change, only be reversed. */
export const transferEditFields: Field[] = [
  { name: 'description', label: 'Memo' },
  { name: 'notes', label: 'Notes', type: 'textarea' },
];

export const donorFields: Field[] = [
  { name: 'country', label: 'Country', type: 'select', options: [['US', 'USA'], ['CA', 'Canada'], ['IL', 'Israel'], ['GB', 'England']].map(([value, label]) => ({ value, label })) },
  { name: 'english_title', label: 'English Title' },
  { name: 'first_name', label: 'First Name' },
  { name: 'last_name', label: 'Last Name' },
  { name: 'yiddish_title', label: 'Yiddish Title' },
  { name: 'yiddish_first_name', label: 'Yiddish First Name' },
  { name: 'yiddish_last_name', label: 'Yiddish Last Name' },
  { name: 'yiddish_suffix', label: 'Yiddish Suffix' },
  { name: 'phone', label: 'Phone' },
  { name: 'email', label: 'Email', type: 'email' },
  { name: 'address', label: 'Address' },
  { name: 'ojc_id', label: 'OJC ID' },
  { name: 'nadvan_id', label: 'Nadvan ID' },
  { name: 'matbia_id', label: 'Matbia ID' },
  { name: 'pledger_id', label: 'Pledger ID' },
  { name: 'notes', label: 'Notes', type: 'textarea' },
];

export const personFields: Field[] = [
  { name: 'first_name', label: 'First Name', required: true },
  { name: 'last_name', label: 'Last Name' },
  { name: 'phone', label: 'Phone' },
  { name: 'email', label: 'Email', type: 'email', help: 'For fundraisers, this email is how their login is matched' },
  { name: 'notes', label: 'Notes', type: 'textarea' },
];

export const sourceFields: Field[] = [
  { name: 'id', label: 'Source key', required: true, help: 'Device / gateway key as it appears on donations, e.g. DP_10281' },
  { name: 'name', label: 'Name', required: true },
  { name: 'number', label: 'Number' },
];

export const accountFields: Field[] = [
  { name: 'name', label: 'Account', required: true },
  { name: 'filter_checks', label: 'Filter Checks', type: 'checkbox' },
  { name: 'notes', label: 'Notes', type: 'textarea' },
];

export const taskFields: Field[] = [
  { name: 'title', label: 'Task', required: true },
  { name: 'campaign_id', label: 'Campaign', type: 'search', options: campaignOptions, create: create.campaign },
  { name: 'donor_id', label: 'Donor', type: 'search', options: donorOptions, create: create.donor },
  { name: 'assigned_to', label: 'Assigned to' },
  { name: 'status', label: 'Status', type: 'select', options: TASK_STATUSES, required: true },
  { name: 'due_date', label: 'Due', type: 'date' },
  { name: 'description', label: 'Description', type: 'textarea' },
  { name: 'notes', label: 'Notes', type: 'textarea' },
];
