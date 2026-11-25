// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Transactions > Donary cash & checks (Shulim, 2026-11-25). Sample data only.
let mode: string | null = 'review';
const held = [
  { id: 'h1', created_at: '2026-11-24T15:00:00Z', amount: 50, payment_method: 'Cash', donor_name: 'Sample Donor', campaign_id: '1001', campaign_internal: 'Sample Campaign', collector_name: 'Sample Fundraiser', donary_id: 'DN-1' },
  { id: 'h2', created_at: '2026-11-24T16:00:00Z', amount: 180, payment_method: 'Check', check_number: '1001', donor_name: 'Sample Donor 2', campaign_id: '1001', campaign_internal: 'Sample Campaign', collector_name: null, donary_id: 'DN-2' },
];
const rpc = vi.fn(async () => ({ data: 1, error: null }));
const chain = (result: unknown) => {
  const c: Record<string, unknown> = {};
  for (const k of ['select', 'eq', 'not', 'order']) c[k] = () => c;
  c.limit = async () => result;
  c.maybeSingle = async () => result;
  return c;
};
vi.mock('../lib/supabase', () => ({
  supabase: {
    from: (t: string) => (t === 'settings' ? chain({ data: mode == null ? null : { value: mode }, error: null }) : chain({ data: held, error: null })),
    rpc: (...a: unknown[]) => rpc(...(a as [])),
  },
}));
import { DonaryHeldPage } from './DonaryHeld';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
async function show() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => createRoot(host).render(<MemoryRouter><DonaryHeldPage /></MemoryRouter>));
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
  return host;
}

describe('Donary cash & checks page', () => {
  beforeEach(() => { rpc.mockClear(); mode = 'review'; });

  it('ignoring them (the default): says how many are held and not counted, with no list', async () => {
    mode = null;
    const host = await show();
    expect(host.textContent).toContain('This organization ignores them');
    expect(host.textContent).toContain('2 held ($230.00), not counted');
    expect(host.querySelector('table')).toBeNull();
  });

  it('flagged for review: lists them, and Mark delivered sends that gift', async () => {
    const host = await show();
    expect(host.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(host.textContent).toContain('Check #1001');
    const button = [...host.querySelectorAll('tbody button')].find(b => b.textContent === 'Mark delivered')!;
    await act(async () => { (button as HTMLButtonElement).click(); });
    expect(rpc).toHaveBeenCalledWith('mark_donary_delivered', { p_ids: ['h1'] });
    expect(host.textContent).toContain('1 marked delivered; it counts from now on.');
  });

  it('has its tab under Transactions (admins), the setting on the Organization page, and a Held status', () => {
    expect(readFileSync('src/components/Layout.tsx', 'utf8')).toContain("{ to: '/donations/donary-held', label: 'Donary cash & checks', admin: true }");
    expect(readFileSync('src/App.tsx', 'utf8')).toContain('<Route path="donations/donary-held" element={<AdminOnly><DonaryHeldPage /></AdminOnly>} />');
    expect(readFileSync('src/pages/Organization.tsx', 'utf8')).toContain('<DonaryCashCheckSetting orgId={String(org.id)} />');
    expect(readFileSync('src/lib/lookups.ts', 'utf8')).toContain("['held', 'Held (Donary cash/check)']");
  });
});
