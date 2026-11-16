// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

// Moshe Henig, 2026-11-15 (readiness #41): clicking a donation opens a read-only view first, with Edit and Issue
// Receipt on top.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('../lib/supabase', () => {
  const chain: any = { select: () => chain, contains: () => chain, order: async () => ({ data: [] }), eq: () => chain, in: () => chain };
  return { supabase: { from: () => chain, rpc: async () => ({ data: null }) }, fetchAll: async () => [] };
});
import DonationView from './DonationView';

const row = { id: 'tx-41', amount: 180, fee: 5.4, net_donation: 174.6, status: 'completed', type: 'Payment', payment_method: 'Cash', campaign_id: '1001',
  campaigns: { id: '1001', internal_name: 'Sample Campaign' }, donors: { display_name: 'Sample Donor' }, created_at: '2026-11-12T15:00:00Z', notes: 'At the dinner' };

describe('a donation, read-only first', () => {
  it('shows the donation without inputs, with Edit and Issue receipt on top', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const onEdit = vi.fn();
    const root = createRoot(host);
    await act(async () => root.render(<MemoryRouter><DonationView row={row} onEdit={onEdit} onClose={() => {}} /></MemoryRouter>));
    const modal = document.body.querySelector('.modal') as HTMLElement;
    expect(modal.textContent).toContain('Donation tx-41');
    expect(modal.textContent).toContain('Sample Donor');
    expect(modal.textContent).toContain('$180.00');
    expect(modal.textContent).toContain('At the dinner');
    expect(modal.querySelectorAll('input, select, textarea')).toHaveLength(0);
    const buttons = [...modal.querySelectorAll('.donation-view-actions button')].map(b => b.textContent?.trim());
    expect(buttons[0]).toBe('Edit');
    expect(buttons).toContain('Issue receipt');
    await act(async () => { (modal.querySelector('.donation-view-actions button') as HTMLButtonElement).click(); });
    expect(onEdit).toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('is what clicking a donation opens for admins; Edit then opens the edit form', () => {
    const src = readFileSync('src/pages/Donations.tsx', 'utf8');
    expect(src).toContain('return { open: setViewing, editor };');
    expect(src).toContain('onEdit={() => { setEditing(viewing); setViewing(null); }}');
  });
});
