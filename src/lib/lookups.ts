import { fetchAll, supabase } from './supabase';

export interface Option {
  value: string;
  label: string;
}

const cache = new Map<string, Promise<Option[]>>();

function cached(key: string, load: () => Promise<Option[]>) {
  if (!cache.has(key)) cache.set(key, load().catch(e => (cache.delete(key), Promise.reject(e))));
  return cache.get(key)!;
}

export const clearLookups = () => cache.clear();

export const campaignOptions = () =>
  cached('campaigns', async () =>
    (await fetchAll((a, b) => supabase.from('campaigns').select('id, campaign_name, friendly_name, real_name, archived_at').order('id').range(a, b)))
      .map(c => ({
        value: c.id,
        label: `${c.id} - ${c.real_name || c.campaign_name || c.friendly_name || ''}${c.archived_at ? ' (archived)' : ''}`,
      })),
  );

export const managerOptions = () =>
  cached('managers', async () =>
    (await fetchAll((a, b) => supabase.from('managers').select('id, full_name').order('full_name').range(a, b)))
      .map(m => ({ value: m.id, label: m.full_name || m.id })),
  );

export const collectorOptions = () =>
  cached('collectors', async () =>
    (await fetchAll((a, b) => supabase.from('collectors').select('id, full_name').order('full_name').range(a, b)))
      .map(m => ({ value: m.id, label: m.full_name || m.id })),
  );

export const donorOptions = () =>
  cached('donors', async () =>
    (await fetchAll((a, b) => supabase.from('donors').select('id, display_name, phone').order('display_name').range(a, b)))
      .map(d => ({ value: d.id, label: `${d.display_name}${d.phone ? ` · ${d.phone}` : ''}` })),
  );

export const accountOptions = () =>
  cached('accounts', async () =>
    (await fetchAll((a, b) => supabase.from('accounts').select('id, name').order('name').range(a, b)))
      .map(a => ({ value: a.id, label: a.name })),
  );

export const sourceOptions = () =>
  cached('sources', async () =>
    (await fetchAll((a, b) => supabase.from('sources').select('id, name').order('name').range(a, b)))
      .map(s => ({ value: s.id, label: s.name })),
  );

export const PAYMENT_METHODS = [
  'Matbia', 'Credit Card', 'Credit Card VISA', 'Credit Card MASTERCARD', 'Credit Card AMEX', 'Credit Card DISCOVER',
  'OJC', 'OJC Voucher', 'Pledger Voucher', 'Donors Fund Voucher', 'Pledger Pledger', 'Check', 'Cash', 'Zelle', 'Wire', 'usaepay', 'Other',
].map(v => ({ value: v, label: v }));

export const EXPENSE_METHODS = ['Check', 'Zelle', 'Account Transfer', 'Credit Card', 'Cash', 'Wire', 'other'].map(v => ({ value: v, label: v }));
export const DONATION_TYPES = ['Payment', 'Batch', 'Collect', 'Voided'].map(v => ({ value: v, label: v }));
export const TASK_STATUSES = ['Pending', 'In Progress', 'Done'].map(v => ({ value: v, label: v }));
