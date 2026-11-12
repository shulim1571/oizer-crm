import type { Field } from '../components/RecordForm';
import type { Row } from './supabase';
import { localToday } from './format';
import {
  CAMPAIGN_STATUSES, DONATION_STATUSES, DONATION_TYPES, payeeOptions, payoutMethodOptions, paymentMethodOptions, voucherIssuerOptions, TASK_STATUSES, accountOptions, campaignOptions,
  donorOptions, managerOptions, sourceOptions,
} from './lookups';

const create = {
  campaign: () => ({ noun: 'campaign', table: 'campaigns', fields: newCampaignFields, defaults: { status: 'active' } }),
  fundraiser: () => ({ noun: 'fundraiser', table: 'managers', fields: personFields }),
  // Opened through NewDonorDialog, which gives fundraisers their own short donor form.
  donor: () => ({ noun: 'donor', table: 'donors', fields: donorFields, defaults: { country: 'US' } }),
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
  { name: 'pin', label: 'Phone PIN', help: '4 digits. Lets a fundraiser on an unregistered phone hear this campaign by text or phone. It’s stored scrambled and never shown: type a new one to change it, leave empty to keep it. Remove it from More.' },
  { name: 'featured', label: 'Featured', type: 'checkbox' },
  { name: 'notes', label: 'Notes', type: 'textarea' },
];

export const newCampaignFields: Field[] = [
  ...campaignFields,
  { name: 'status', label: 'Status', type: 'select', options: CAMPAIGN_STATUSES, required: true },
];

/** The payment method, for showing fields that only apply to some methods. */
const method = (v: Row) => String(v.payment_method ?? '').trim().toLowerCase();
const isCheck = (v: Row) => method(v).startsWith('check');
const isCashOrCheck = (v: Row) => isCheck(v) || method(v).startsWith('cash');
const CHECK_ONLY = ['check_number', 'post_dated', 'check_date'];

export const donationFields: Field[] = [
  { name: 'campaign_id', label: 'Campaign', type: 'search', options: campaignOptions, required: true, create: create.campaign },
  { name: 'type', label: 'Type', type: 'select', options: DONATION_TYPES, required: true },
  { name: 'status', label: 'Status', type: 'select', options: DONATION_STATUSES, required: true },
  { name: 'amount', label: 'Amount', type: 'number', required: true },
  { name: 'payment_method', label: 'Payment Method', type: 'select', options: paymentMethodOptions, freeText: true },
  // Check fields show only for a check, here and in every donation form (Moshe Henig, 2026-11-11).
  { name: 'check_number', label: 'Check #', showIf: isCheck },
  { name: 'post_dated', label: 'Post-dated check', type: 'checkbox', showIf: isCheck },
  { name: 'check_date', label: 'Check date', type: 'date', help: 'A later date keeps it out of the balance until then', showIf: isCheck },
  { name: 'anonymous', label: 'Anonymous', type: 'checkbox' },
  { name: 'donor_id', label: 'Donor', type: 'search', options: donorOptions, create: create.donor },
  { name: 'name', label: 'Name on payment' },
  { name: 'phone', label: 'Phone' },
  { name: 'email', label: 'Email', type: 'email' },
  { name: 'source', label: 'Source', advanced: true, type: 'select', options: sourceOptions, create: create.source },
  { name: 'account_id', label: 'Account', advanced: true, type: 'select', options: accountOptions, create: create.account, help: 'Leave empty to route it automatically' },
  { name: 'fee', label: 'Fee', advanced: true, type: 'number', help: "Leave empty to use the method's fee. Enter 0 to waive it." },
  { name: 'manual_fee', label: 'Manual Fee', advanced: true, type: 'number' },
  { name: 'batch_id', label: 'Batch ID / Voucher #', advanced: true },
  { name: 'funded', label: 'Funded', advanced: true, type: 'number', help: 'Batch rows: amount actually received' },
  { name: 'batch_status', label: 'Batch Status', advanced: true, type: 'select', options: ['Open', 'Complete'].map(v => ({ value: v, label: v })) },
  { name: 'batch_pending', label: 'Batch Pending', advanced: true, type: 'number' },
  { name: 'delivered', label: 'Delivered', advanced: true, type: 'checkbox' },
  { name: 'created_at', label: 'Timestamp', advanced: true, type: 'datetime' },
  { name: 'notes', label: 'Notes', type: 'textarea' },
];

/** Batch rows come in through vouchers and batch entry, which have their own forms. */
const BATCH_ONLY = ['batch_id', 'funded', 'batch_status', 'batch_pending'];

/**
 * The New Donation form (Moshe Henig, 2026-11-10): check fields only for a check, Delivered only for cash or a
 * check, no batch fields or Batch type (vouchers have their own form), and Manual fee always in view.
 * Editing a donation keeps the full form, so batch rows can still be corrected.
 */
/**
 * Layout of the New Donation form (Moshe Henig, 2026-11-11: "looks messy"): the same fields and rules, grouped into
 * Gift, Payment and Donor sections in this order, then Notes; the accounting fields stay folded under Advanced.
 */
const NEW_DONATION_LAYOUT: [string, string[]][] = [
  ['Gift', ['campaign_id', 'amount']],
  ['Payment', ['payment_method', 'manual_fee', 'check_number', 'check_date', 'post_dated', 'delivered']],
  ['Donor', ['donor_id', 'name', 'phone', 'email', 'anonymous']],
];

/**
 * Moshe Henig, 2026-11-11 (by text): no Type field (it's always Payment, sent by the form's defaults), Status at the
 * bottom, and only Source, Account and Timestamp under Advanced. Editing a donation keeps every field.
 */
const NEW_DONATION_HIDDEN = ['type', 'fee'];
const NEW_DONATION_LAST = ['status'];

const newDonationRules: Field[] = donationFields
  .filter(f => !BATCH_ONLY.includes(f.name) && !NEW_DONATION_HIDDEN.includes(f.name))
  .map(f => {
    if (f.name === 'type') return { ...f, options: DONATION_TYPES.filter(o => o.value !== 'Batch') };
    // A searchable dropdown of the organization's payment methods, like Campaign (Moshe Henig, 2026-11-11).
    if (f.name === 'payment_method') return { ...f, type: 'search' as const, freeText: undefined };
    if (CHECK_ONLY.includes(f.name)) return { ...f, showIf: isCheck };
    if (f.name === 'delivered') return { ...f, showIf: isCashOrCheck, advanced: false };
    if (f.name === 'manual_fee') return { ...f, advanced: false };
    return f;
  });

export const newDonationFields: Field[] = [
  ...NEW_DONATION_LAYOUT.flatMap(([section, names]) => names.map(n => ({ ...newDonationRules.find(f => f.name === n)!, section }))),
  ...newDonationRules.filter(f => !f.advanced && !NEW_DONATION_LAST.includes(f.name) && !NEW_DONATION_LAYOUT.some(([, names]) => names.includes(f.name))),
  ...NEW_DONATION_LAST.map(n => newDonationRules.find(f => f.name === n)!),
  ...newDonationRules.filter(f => f.advanced),
];

/**
 * Editing a donation uses the same fields and rules as New Donation (Moshe Henig, 2026-11-11: "any other
 * unnecessary fields that we took out shouldn't be found anywhere else either"). Type, Fee, Collector and the batch
 * fields are gone from every form; what older rows already have stays stored and unchanged.
 */
export const editDonationFields: Field[] = newDonationFields;

/** What a fundraiser with the override fills in. It always waits for an admin. */
export const fundraiserDonationFields: Field[] = [
  { name: 'amount', label: 'Amount', type: 'number', required: true },
  { name: 'payment_method', label: 'Payment Method', type: 'select', options: paymentMethodOptions, freeText: true, required: true },
  { name: 'name', label: 'Donor name' },
  { name: 'phone', label: 'Phone' },
  { name: 'check_number', label: 'Check #', showIf: isCheck },
  { name: 'notes', label: 'Notes', type: 'textarea' },
];

const pledgeWho: Field[] = [
  { name: 'donor_id', label: 'Donor', type: 'search', options: donorOptions, create: create.donor, help: 'Payments match automatically only when a donor is linked' },
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
  // Oizer's voucher ref # (VCH-...), filled in when the form opens and never typed (Moshe Henig, 2026-11-11).
  { name: 'id', label: 'Voucher ref #', readOnly: true, help: 'Filled in by Oizer. Write this on the physical voucher' },
  { name: 'issuer_number', label: 'Issuer voucher / batch #' },
  { name: 'campaign_id', label: 'Campaign', type: 'search', options: campaignOptions, required: true },
  { name: 'donor_id', label: 'Donor', type: 'search', options: donorOptions, create: create.donor },
  { name: 'name', label: 'Donor name, if not linked' },
  { name: 'face_value', label: 'Face value', type: 'number', required: true },
  // One fee field (Moshe Henig, 2026-11-11): an amount, or empty for the issuer's rate.
  { name: 'fee_flat', label: 'Fee ($)', type: 'number', help: "Taken when the funds arrive. Leave empty to use the issuer's rate from Methods & Fees. It can't change after funds arrive." },
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

/** A new payout is for now: today's date to process on, and the current time (Moshe Henig, 2026-11-10). Both stay editable. */
export const newPayoutDefaults = () => ({ scheduled_for: localToday(), created_at: new Date().toISOString() });

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
