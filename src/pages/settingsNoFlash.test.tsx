// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

// Readiness #45 (2026-11-15): on a slow network, Payments showed the keys as Missing (and Account security showed
// text codes as Off) before the real settings arrived.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let answer: (v: unknown) => void = () => {};
vi.mock('../lib/supabase', () => {
  const chain: any = { select: () => chain, eq: () => chain, order: () => chain, maybeSingle: async () => ({ data: null }), then: (r: any) => r({ data: [] }) };
  return {
    requestOrgId: () => 'org',
    fetchAll: async () => [],
    supabase: {
      from: () => chain,
      functions: { invoke: async () => ({ data: null }) },
      // payment_config answers only when the test says so: a slow network.
      rpc: (name: string) => (name === 'payment_config' ? new Promise(r => { answer = r; }) : Promise.resolve({ data: [] })),
    },
  };
});
vi.mock('../lib/auth', () => ({ useAuth: () => ({ isSuperAdmin: true, isAdmin: true, org: { id: 'org' }, permissions: [] }) }));
import { PaymentsSettingsPage } from './Payments';

describe('settings while they load', () => {
  it('says Checking…, not Missing, until the payment settings arrive', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(<MemoryRouter><PaymentsSettingsPage /></MemoryRouter>));
    const status = () => host.querySelector('.record-facts')?.textContent ?? '';
    expect(status()).toContain('Checking…');
    expect(status()).not.toContain('Missing');
    await act(async () => { answer({ data: [{ ifields_key: 'k', sandbox: true, api_key_set: true, pin_set: true }] }); });
    expect(status()).toContain('Set');
    expect(status()).not.toContain('Checking…');
    act(() => root.unmount());
  });

  it('shows no On or Off for two-step codes until they have loaded', () => {
    const s = readFileSync('src/pages/Security.tsx', 'utf8');
    expect(s).toContain('Text or call codes {mfa.loading ? <span className="muted small">Checking…</span>');
    expect(s).toContain('Authenticator app {mfa.loading ? <span className="muted small">Checking…</span>');
  });
});
