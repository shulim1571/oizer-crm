import type { Field } from '../components/RecordForm';
import {
  DONATION_TYPES, EXPENSE_METHODS, PAYMENT_METHODS, TASK_STATUSES, accountOptions, campaignOptions,
  collectorOptions, donorOptions, managerOptions, sourceOptions,
} from './lookups';

export const campaignFields: Field[] = [
  { name: 'id', label: 'Campaign ID', required: true, help: 'Campaign number, e.g. 3290' },
  { name: 'real_name', label: 'Real Name' },
  { name: 'friendly_name', label: 'Friendly Name' },
  { name: 'campaign_name', label: 'Campaign Name' },
  { name: 'manager_id', label: 'Manager', type: 'search', options: managerOptions },
  { name: 'sub_manager_ids', label: 'Sub Managers', type: 'multi', options: managerOptions },
  { name: 'email', label: 'Email', type: 'email' },
  { name: 'phone', label: 'Phone' },
  { name: 'payment_link', label: 'Payment Link' },
  { name: 'pin', label: 'Pin' },
  { name: 'exchange', label: 'Exchange', type: 'checkbox' },
  { name: 'archived_at', label: 'Archived on', type: 'datetime', help: 'Leave empty to keep the campaign active' },
  { name: 'notes', label: 'Notes', type: 'textarea' },
];

export const donationFields: Field[] = [
  { name: 'campaign_id', label: 'Campaign', type: 'search', options: campaignOptions, required: true },
  { name: 'type', label: 'Type', type: 'select', options: DONATION_TYPES, required: true },
  { name: 'amount', label: 'Amount', type: 'number', required: true },
  { name: 'payment_method', label: 'Payment Method', type: 'select', options: PAYMENT_METHODS, freeText: true },
  { name: 'donor_id', label: 'Donor', type: 'search', options: donorOptions },
  { name: 'name', label: 'Name on payment' },
  { name: 'phone', label: 'Phone' },
  { name: 'email', label: 'Email', type: 'email' },
  { name: 'collector_id', label: 'Collector', type: 'search', options: collectorOptions },
  { name: 'source', label: 'Source', type: 'select', options: sourceOptions },
  { name: 'account_id', label: 'Account', type: 'select', options: accountOptions },
  { name: 'fee', label: 'Fee', type: 'number' },
  { name: 'manual_fee', label: 'Manual Fee', type: 'number' },
  { name: 'batch_id', label: 'Batch ID / Voucher #' },
  { name: 'funded', label: 'Funded', type: 'number', help: 'Batch rows: amount actually received' },
  { name: 'batch_status', label: 'Batch Status', type: 'select', options: ['Open', 'Complete'].map(v => ({ value: v, label: v })) },
  { name: 'batch_pending', label: 'Batch Pending', type: 'number' },
  { name: 'delivered', label: 'Delivered', type: 'checkbox' },
  { name: 'created_at', label: 'Timestamp', type: 'datetime' },
  { name: 'notes', label: 'Notes', type: 'textarea' },
];

export const expenseFields: Field[] = [
  { name: 'campaign_id', label: 'Campaign', type: 'search', options: campaignOptions, required: true },
  { name: 'payee', label: 'To' },
  { name: 'amount', label: 'Amount', type: 'number', required: true },
  { name: 'method', label: 'Method', type: 'select', options: EXPENSE_METHODS, freeText: true },
  { name: 'account_id', label: 'Account', type: 'select', options: accountOptions },
  { name: 'check_number', label: 'Check Number' },
  { name: 'memo', label: 'Memo' },
  { name: 'description', label: 'Description' },
  { name: 'cleared', label: 'Cleared', type: 'checkbox' },
  { name: 'created_at', label: 'Timestamp', type: 'datetime' },
  { name: 'notes', label: 'Notes', type: 'textarea' },
];

export const transferFields: Field[] = [
  { name: 'from_campaign_id', label: 'From campaign', type: 'search', options: campaignOptions },
  { name: 'to_campaign_id', label: 'To campaign', type: 'search', options: campaignOptions, required: true },
  { name: 'amount', label: 'Amount', type: 'number', required: true },
  { name: 'description', label: 'Description' },
  { name: 'created_at', label: 'Timestamp', type: 'datetime' },
  { name: 'notes', label: 'Notes', type: 'textarea' },
];

export const donorFields: Field[] = [
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
  { name: 'email', label: 'Email', type: 'email', help: 'For managers, this email is how their login is matched' },
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
  { name: 'campaign_id', label: 'Campaign', type: 'search', options: campaignOptions, required: true },
  { name: 'donor_id', label: 'Donor', type: 'search', options: donorOptions },
  { name: 'assigned_to', label: 'Assigned to' },
  { name: 'status', label: 'Status', type: 'select', options: TASK_STATUSES, required: true },
  { name: 'due_date', label: 'Due', type: 'date' },
  { name: 'description', label: 'Description', type: 'textarea' },
  { name: 'notes', label: 'Notes', type: 'textarea' },
];
