// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

// The organization's email inbox page (2026-11-19): only inbox managers see it; the address card shows the address
// with Copy and forwarding help; nothing on the page posts anything to the books.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let perms: string[] = ['manage_inbox'];
vi.mock('../lib/auth', () => ({ useAuth: () => ({ permissions: perms, isAdmin: true, org: { id: 'o' }, profile: { user_id: 'u' } }) }));
vi.mock('../lib/supabase', () => {
  const chain: any = { select: () => chain, eq: () => chain, order: () => chain, range: async () => ({ data: [] }), maybeSingle: async () => ({ data: { keep_years: 7, daily_cap: 500 } }), then: (r: any) => r({ data: [] }) };
  return {
    fetchAll: async () => [],
    supabase: {
      from: () => chain,
      rpc: async (name: string) => (name === 'inbox_status'
        ? { data: [{ address: 'k7f3q9xw2m4t8p1z6c0d@inbox.example.test', status: 'active', domain_set: true, created_at: '2026-11-19T15:00:00Z', created_by: 'admin@example.org', keep_years: 7 }] }
        : { data: [] }),
    },
  };
});
import EmailInboxPage from './EmailInbox';

async function render() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<MemoryRouter initialEntries={['/email-inbox?tab=address']}><EmailInboxPage /></MemoryRouter>));
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
  return { host, root };
}

describe('Email Inbox page', () => {
  it('is only for admins with the Inbox permission', async () => {
    perms = [];
    const { host, root } = await render();
    expect(host.textContent).toContain('for admins with the Inbox permission');
    act(() => root.unmount());
    perms = ['manage_inbox'];
  });

  it('shows the address with Copy, replace, turn off and forwarding help', async () => {
    const { host, root } = await render();
    const tab = [...host.querySelectorAll('button')].find(b => b.textContent === 'Address & settings');
    if (tab) await act(async () => { tab.click(); await new Promise(r => setTimeout(r, 0)); });
    expect(host.textContent).toContain('k7f3q9xw2m4t8p1z6c0d@inbox.example.test');
    expect(host.textContent).toContain('Copy');
    expect(host.textContent).toContain('Replace address');
    expect(host.textContent).toContain('Turn off');
    expect(host.textContent).toContain('How to send mail here');
    act(() => root.unmount());
  });

  it('never posts to the books: no donation, voucher or fee calls', () => {
    const src = readFileSync('src/pages/EmailInbox.tsx', 'utf8');
    expect(src).not.toMatch(/from\('donations'\)|from\('vouchers'\)|rpc\('(add_voucher_funding|split_donation|refund)/);
    expect(src).toContain("supabase.storage.from('inbox').createSignedUrl(path, 60, { download: true })");
  });
});
