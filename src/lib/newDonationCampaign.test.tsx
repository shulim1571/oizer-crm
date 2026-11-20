// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

// Readiness #39 (2026-11-15): typing "3056" quickly on New Donation picked an archived campaign and cleared the method.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('./supabase', () => ({
  supabase: { from: () => ({}), rpc: async () => ({ data: null }) },
  fetchAll: async () => [
    { id: '3055', internal_name: 'Spring', status: 'active', parent_campaign_id: null },
    { id: '3056', internal_name: 'Old drive', status: 'archived', parent_campaign_id: null },
  ],
}));
vi.mock('./auth', () => ({ useAuth: () => ({ isAdmin: true, canWork: true, permissions: [] }) }));
import { activeCampaignOptions, campaignOptions } from './lookups';
import RecordForm, { type Field } from '../components/RecordForm';

describe('New Donation campaign box', () => {
  it('offers active campaigns only; editing a gift still offers archived ones', async () => {
    expect((await activeCampaignOptions()).map(o => o.value)).toEqual(['3055']);
    expect((await campaignOptions()).map(o => o.value).sort()).toEqual(['3055', '3056']);
  });

  it('keeps the payment method when the campaign changes', async () => {
    const fields: Field[] = [
      { name: 'campaign_id', label: 'Campaign', type: 'select', options: [{ value: '3055', label: 'Spring - 3055' }, { value: '3057', label: 'Summer - 3057' }] },
      { name: 'payment_method', label: 'Payment Method', type: 'select', options: [{ value: 'Cash', label: 'Cash' }, { value: 'Check', label: 'Check' }] },
    ];
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(<MemoryRouter><RecordForm inline table="donations" title="t" fields={fields} onClose={() => {}} onSaved={() => {}} /></MemoryRouter>));
    const [campaign, method] = [...host.querySelectorAll('select')] as HTMLSelectElement[];
    const choose = (el: HTMLSelectElement, v: string) => act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, v);
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await choose(method, 'Check');
    await choose(campaign, '3055');
    await choose(campaign, '3057');
    expect(method.value).toBe('Check');
    act(() => root.unmount());
  });
});
