import { fetchAll, supabase } from './supabase';
import { formatPhone } from './format';

export interface Option {
  value: string;
  label: string;
}

const cache = new Map<string, Promise<Option[]>>();

import { byLabel } from './byLabel';
export { byLabel };

function cached(key: string, load: () => Promise<Option[]>) {
  if (!cache.has(key)) cache.set(key, load().then(list => [...list].sort(byLabel)).catch(e => (cache.delete(key), Promise.reject(e))));
  return cache.get(key)!;
}

export const clearLookups = () => cache.clear();

export const campaignOptions = () =>
  cached('campaigns', async () =>
    (await fetchAll((a, b) => supabase.from('campaigns').select('id, campaign_name, external_name, internal_name, status, parent_campaign_id').neq('status', 'closed').order('id').range(a, b)))
      .map(c => ({
        value: c.id,
        // Name first, so the list reads alphabetically; the ID still finds it when typed.
        label: `${c.internal_name || c.campaign_name || c.external_name || c.id} - ${c.id}${c.parent_campaign_id ? ` (under ${c.parent_campaign_id})` : ''}${c.status === 'archived' ? ' (archived)' : c.status === 'draft' ? ' (draft)' : ''}`,
      })),
  );

/**
 * Campaigns a new gift can go to: not archived, not closed (readiness #39: typing "3056" quickly on New Donation picked
 * an archived campaign). Editing a gift still offers every campaign but closed ones.
 */
export const activeCampaignOptions = async () => (await campaignOptions()).filter(o => !/\(archived\)$/.test(o.label));

export const managerOptions = () =>
  cached('managers', async () =>
    (await fetchAll((a, b) => supabase.from('managers').select('id, full_name, status').neq('status', 'deactivated').order('full_name').range(a, b)))
      .map(m => ({ value: m.id, label: `${m.full_name || m.id}${m.status === 'suspended' ? ' (suspended)' : ''}` })),
  );


export const donorOptions = () =>
  cached('donors', async () =>
    (await fetchAll((a, b) => supabase.from('donors').select('id, display_name, phone').order('display_name').range(a, b)))
      .map(d => ({ value: d.id, label: `${d.display_name}${d.phone ? ` · ${formatPhone(d.phone)}` : ''}` })),
  );

/** Every account; credit cards say so ("Sample Card ···4242 (card)"), so a payout can be charged to the card. */
export const accountOptions = () =>
  cached('accounts', async () =>
    (await fetchAll((a, b) => supabase.from('accounts').select('id, name, kind, card_last4').order('name').range(a, b)))
      .map(a => ({ value: a.id, label: a.kind === 'credit_card' ? `${a.name}${a.card_last4 ? ` ···${a.card_last4}` : ''} (card)` : a.name })),
  );
/** Bank accounts only (where a card's bill is paid from). */
export const bankAccountOptions = () =>
  cached('bank-accounts', async () =>
    (await fetchAll((a, b) => supabase.from('accounts').select('id, name, kind').order('name').range(a, b)))
      .filter(a => a.kind !== 'credit_card').map(a => ({ value: a.id, label: a.name })),
  );

export const sourceOptions = () =>
  cached('sources', async () =>
    (await fetchAll((a, b) => supabase.from('sources').select('id, name').order('name').range(a, b)))
      .map(s => ({ value: s.id, label: s.name })),
  );

/** Methods marked "is a check" (readiness #59), filled in when the methods are loaded for a form. */
export const CHECK_METHODS = new Set<string>();

export const paymentMethodOptions = () =>
  cached('paymentMethods', async () => {
    const list = await fetchAll((a, b) => supabase.from('payment_methods').select('name, is_check').eq('active', true).neq('category', 'Voucher').order('name').range(a, b));
    CHECK_METHODS.clear();
    for (const m of list) if (m.is_check) CHECK_METHODS.add(String(m.name).toLowerCase());
    return list.map(m => ({ value: m.name, label: m.name }));
  });

export const voucherIssuerOptions = () =>
  cached('voucherIssuers', async () =>
    (await fetchAll((a, b) => supabase.from('payment_methods').select('name').eq('active', true).eq('category', 'Voucher').order('name').range(a, b)))
      .map(m => ({ value: m.name, label: m.name.replace(/^Voucher\s*—\s*/, '') })),
  );

export const paymentMethodIdOptions = () =>
  cached('paymentMethodIds', async () =>
    (await fetchAll((a, b) => supabase.from('payment_methods').select('id, name').order('name').range(a, b)))
      .map(m => ({ value: m.id, label: m.name })),
  );

export const payoutMethodOptions = () =>
  cached('payoutMethods', async () =>
    (await fetchAll((a, b) => supabase.from('payout_methods').select('name').eq('active', true).order('name').range(a, b)))
      .map(m => ({ value: m.name, label: m.name })),
  );

/** Admins only; fundraisers search with lookup_payees. */
export const payeeOptions = () =>
  cached('payees', async () =>
    (await fetchAll((a, b) => supabase.from('payees').select('id, name, phone').is('merged_into', null).order('name').range(a, b)))
      .map(p => ({ value: p.id, label: `${p.name}${p.phone ? ` · ${formatPhone(p.phone)}` : ''}` })),
  );

export const EXPENSE_METHODS = ['Check', 'Zelle', 'Account Transfer', 'Credit Card', 'Cash', 'Wire', 'other'].map(v => ({ value: v, label: v }));
export const DONATION_TYPES = ['Payment', 'Batch'].map(v => ({ value: v, label: v }));
export const DONATION_STATUSES = [
  ['completed', 'Completed'], ['pending', 'Pending approval'], ['post_dated', 'Post-dated'], ['collect', 'To collect'], ['voided', 'Voided'],
  ['refunded', 'Refunded'], ['returned', 'Returned'], ['failed', 'Failed'], ['rejected', 'Rejected'],
  // Donary cash or check, not counted until marked delivered (Shulim, 2026-11-25).
  ['held', 'Held (Donary cash/check)'],
].map(([value, label]) => ({ value, label }));
export const CAMPAIGN_STATUSES = [['draft', 'Draft'], ['active', 'Active']].map(([value, label]) => ({ value, label }));
export const TASK_STATUSES = ['Pending', 'In Progress', 'Done'].map(v => ({ value: v, label: v }));

/** Every payment method's name, vouchers included: what a method alias can map to (Fees, Task Sheet). */
export const paymentMethodNameOptions = async (): Promise<Option[]> =>
  ((await fetchAll((a, b) => supabase.from('payment_methods').select('name').order('name').range(a, b) as never)) as { name: string }[])
    .map(m => ({ value: String(m.name), label: String(m.name) }));
