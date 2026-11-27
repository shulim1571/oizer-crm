// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Moshe, 2026-11-26: Print check only on payouts paid by check. Sample data only.
let checks: Record<string, unknown>[] = [];
vi.mock('../lib/supabase', () => {
  const chain: Record<string, unknown> = {};
  for (const k of ['select', 'eq']) chain[k] = () => chain;
  chain.order = () => Promise.resolve({ data: checks, error: null });
  return { supabase: { from: () => chain, rpc: async () => ({ data: null, error: null }) } };
});
import { PayoutCheckActions, isCheckPayout } from './Checks';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
async function show(record: Record<string, unknown>) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => createRoot(host).render(<MemoryRouter><PayoutCheckActions record={record} onDone={() => {}} /></MemoryRouter>));
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
  return host.textContent ?? '';
}

describe('Print check on payouts', () => {
  beforeEach(() => { checks = []; });

  it('is offered on a payout paid by check, with Email to fundraiser', async () => {
    const t = await show({ id: 'e1', method: 'Check', amount: 100 });
    expect(t).toContain('Print check');
    expect(t).toContain('Email to fundraiser');
  });

  it('is not offered for card, Zelle, cash, wire, ACH or blank payouts', async () => {
    for (const method of ['Credit Card', 'Zelle', 'Cash', 'Wire', 'ACH', 'Account Transfer', null]) {
      const t = await show({ id: `e-${method}`, method, amount: 100 });
      expect(t, String(method)).not.toContain('Print check');
      expect(t, String(method)).not.toContain('Email to fundraiser');
    }
  });

  it('still shows a check already issued for the payout', async () => {
    checks = [{ id: 'k1', check_number: 1042, status: 'outstanding', printed_at: '2026-11-20T10:00:00Z' }];
    const t = await show({ id: 'e2', method: 'Credit Card', amount: 100 });
    expect(t).toContain('Check #1042');
    expect(t).toContain('Print again');
  });

  it('counts methods typed with "check" in them as checks', () => {
    expect(['Check', 'northfiel check', 'Bank Check'].every(isCheckPayout)).toBe(true);
    expect(['Credit Card', 'Zelle', '', null].some(isCheckPayout)).toBe(false);
  });
});

// Moshe, 2026-11-26: summary cards were jammed against the tabs on Settings > Payments > Bank Accounts.
describe('summary cards under tabs', () => {
  it('sit inside the page, in the list\'s summary, on Bank Accounts', () => {
    const page = readFileSync('src/pages/SimplePages.tsx', 'utf8');
    const accounts = page.slice(page.indexOf('function AccountsPage'), page.indexOf('<CrudPage', page.indexOf('function AccountsPage')));
    expect(accounts).not.toContain('<div className="kpis">');   // nothing drawn above the page any more
    expect(page).toContain('summary={(\n        <div className="kpis">\n          <Kpi label="Bank balances (book)"');
    expect(readFileSync('src/components/CrudPage.tsx', 'utf8')).toContain('summary={p.summary}');
  });
});
