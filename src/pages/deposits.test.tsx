// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

// Deposits from email (2026-11-19), sample data only: lines show their suggestions, a person decides each, and the
// deposit is confirmed only after a confirmation. Fee reviews are decided only by admins who can change fees.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let perms: string[] = ['configure_fees'];
const calls: [string, any][] = [];
const DEP = { id: 'dep1', kind: 'ojc_ach', issuer: 'OJC', issuer_ref: 'ACH-SAMPLE', deposit_date: '2026-11-19', gross: 336, fees: 1.08, net: 334.92, status: 'to_review', email_id: 'e1' };
const LINES = [
  { id: 'l1', line_no: 1, kind: 'certificate', ref: 'C-0001', amount: 100, fee: 0, outcome: 'open', suggested_voucher_line: 'vl1', candidates: 0 },
  { id: 'l2', line_no: 2, kind: 'card', ref: 'T-1', amount: 36, fee: 1.08, card_last4: '4242', outcome: 'open', suggested_donation: 'g1', candidates: 1, donor_name: 'Sample Donor' },
];
vi.mock('../lib/auth', () => ({ useAuth: () => ({ permissions: perms, isAdmin: true, org: { id: 'o', name: 'Sample Org' } }) }));
vi.mock('../lib/lookups', async importOriginal => ({ ...(await importOriginal<object>()), activeCampaignOptions: async () => [{ value: '1001', label: 'Sample campaign (1001)' }], paymentMethodNameOptions: async () => [{ value: 'OJC', label: 'OJC' }] }));
vi.mock('../lib/supabase', () => {
  const table = (name: string) => {
    const data = name === 'deposits' ? DEP : name === 'deposit_lines' ? LINES : name === 'voucher_lines' ? [{ id: 'vl1', cert_number: 'C-0001', amount: 100, status: 'submitted' }]
      : name === 'donations' ? [{ id: 'g1', amount: 36, fee: 0, created_at: '2026-11-18T15:00:00Z' }] : null;
    const chain: any = { select: () => chain, eq: () => chain, in: () => chain, order: () => chain, is: () => chain, limit: () => chain,
      maybeSingle: async () => ({ data: Array.isArray(data) ? data[0] : data }), then: (r: any) => r({ data: Array.isArray(data) ? data : data ? [data] : [] }) };
    return chain;
  };
  return { fetchAll: async () => [], supabase: { from: table, rpc: async (n: string, a: any) => { calls.push([n, a]); return { data: null, error: null }; } } };
});
import { DepositView, FeeReviewActions } from './Deposits';

async function render(node: React.ReactNode) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<MemoryRouter>{node}</MemoryRouter>));
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
  return { host, root };
}
const button = (host: HTMLElement, text: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === text)!;

describe('deposit review', () => {
  it('shows suggestions, sends one decision per line, and confirms only when asked twice', async () => {
    const { root } = await render(<DepositView id="dep1" onClose={() => {}} onChanged={() => {}} />);
    const host = document.body;   // the overlay renders at the page level
    expect(host.textContent).toContain('Certificate C-0001');
    expect(host.textContent).toContain('Gift g1');
    expect(host.textContent).toContain('fee differs');
    const match = [...host.querySelectorAll('button')].filter(b => b.textContent === 'Match')[0];
    await act(async () => { match.click(); });
    expect(calls.at(-1)).toEqual(['deposit_line_decide', { p_line: 'l1', p_action: 'match' }]);
    vi.stubGlobal('confirm', () => false);
    await act(async () => { button(host, 'Confirm deposit').click(); });
    expect(calls.some(c => c[0] === 'deposit_decide')).toBe(false);
    vi.stubGlobal('confirm', () => true);
    await act(async () => { button(host, 'Confirm deposit').click(); });
    expect(calls.at(-1)).toEqual(['deposit_decide', { p_deposit: 'dep1', p_action: 'confirm' }]);
    act(() => root.unmount());
  });

  it('lets only admins who can change fees decide a fee review', async () => {
    perms = [];
    const r1 = await render(<FeeReviewActions review={{ id: 'f1', reported_fee: 1.08, recorded_fee: 0 }} onDone={() => {}} />);
    expect(r1.host.textContent).toContain('An admin who can change fees decides this');
    act(() => r1.root.unmount());
    perms = ['configure_fees'];
    const r2 = await render(<FeeReviewActions review={{ id: 'f1', reported_fee: 1.08, recorded_fee: 0 }} onDone={() => {}} />);
    vi.stubGlobal('confirm', () => true);
    await act(async () => { button(r2.host, 'Use $1.08').click(); });
    expect(calls.at(-1)).toEqual(['fee_review_decide', { p_review: 'f1', p_action: 'apply' }]);
    act(() => r2.root.unmount());
  });

  it('offers "Make deposit slip" for selected transactions and certificate lines on vouchers', () => {
    expect(readFileSync('src/pages/TransactionBulk.tsx', 'utf8')).toContain("supabase.rpc('make_deposit_slip', { p_donations: ids })");
    expect(readFileSync('src/pages/Vouchers.tsx', 'utf8')).toContain('{isAdmin && <CertificateLines voucherId={id} />}');
  });
});
