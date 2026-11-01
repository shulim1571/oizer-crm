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
    (await fetchAll((a, b) => supabase.from('campaigns').select('id, campaign_name, external_name, internal_name, status').neq('status', 'closed').order('id').range(a, b)))
      .map(c => ({
        value: c.id,
        label: `${c.id} - ${c.internal_name || c.campaign_name || c.external_name || ''}${c.status === 'archived' ? ' (archived)' : c.status === 'draft' ? ' (draft)' : ''}`,
      })),
  );

export const managerOptions = () =>
  cached('managers', async () =>
    (await fetchAll((a, b) => supabase.from('managers').select('id, full_name, status').neq('status', 'deactivated').order('full_name').range(a, b)))
      .map(m => ({ value: m.id, label: `${m.full_name || m.id}${m.status === 'suspended' ? ' (suspended)' : ''}` })),
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

export const paymentMethodOptions = () =>
  cached('paymentMethods', async () =>
    (await fetchAll((a, b) => supabase.from('payment_methods').select('name').eq('active', true).order('name').range(a, b)))
      .map(m => ({ value: m.name, label: m.name })),
  );

export const paymentMethodIdOptions = () =>
  cached('paymentMethodIds', async () =>
    (await fetchAll((a, b) => supabase.from('payment_methods').select('id, name').order('name').range(a, b)))
      .map(m => ({ value: m.id, label: m.name })),
  );

export const EXPENSE_METHODS = ['Check', 'Zelle', 'Account Transfer', 'Credit Card', 'Cash', 'Wire', 'other'].map(v => ({ value: v, label: v }));
export const DONATION_TYPES = ['Payment', 'Batch'].map(v => ({ value: v, label: v }));
export const DONATION_STATUSES = [
  ['completed', 'Completed'], ['pending', 'Pending approval'], ['post_dated', 'Post-dated'], ['collect', 'To collect'], ['voided', 'Voided'],
  ['refunded', 'Refunded'], ['returned', 'Returned'], ['failed', 'Failed'], ['rejected', 'Rejected'],
].map(([value, label]) => ({ value, label }));
export const CAMPAIGN_STATUSES = [['draft', 'Draft'], ['active', 'Active']].map(([value, label]) => ({ value, label }));
export const TASK_STATUSES = ['Pending', 'In Progress', 'Done'].map(v => ({ value: v, label: v }));
