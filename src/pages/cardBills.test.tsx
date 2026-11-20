// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { accountFields } from '../lib/schemas';

// Credit cards as accounts (Moshe, 2026-11-20), sample data only.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const calls: [string, any][] = [];
vi.mock('../lib/supabase', () => ({ fetchAll: async () => [], supabase: { from: () => ({}), rpc: async (n: string, a: any) => { calls.push([n, a]); return { data: 'x', error: null }; } } }));
vi.mock('../lib/lookups', async importOriginal => ({ ...(await importOriginal<object>()), bankAccountOptions: async () => [{ value: 'bank1', label: 'Sample Operating' }], clearLookups: () => {} }));
import { PayCardBill } from './CardBills';

describe('credit card accounts in the app', () => {
  it('asks for a card\'s last 4, the bank that pays it and the due day only for credit cards', () => {
    const f = (n: string) => accountFields.find(x => x.name === n)!;
    expect(f('kind').options).toEqual([{ value: 'bank', label: 'Bank account' }, { value: 'credit_card', label: 'Credit card' }]);
    for (const n of ['card_last4', 'pays_from_account_id', 'bill_due_day']) {
      expect(f(n).showIf!({ kind: 'credit_card' })).toBe(true);
      expect(f(n).showIf!({ kind: 'bank' })).toBe(false);
    }
    expect(f('card_last4').validate!('12345', {})).toMatch(/last 4/);
  });

  it('records a bill payment as one transfer from the chosen bank, the amount owed filled in', async () => {
    const host = document.createElement('div'); document.body.appendChild(host);
    const root = createRoot(host);
    const done = vi.fn();
    await act(async () => root.render(<PayCardBill card={{ id: 'card1', name: 'Sample Card', card_last4: '4242', card_owed: 200, pays_from_account_id: 'bank1' }} onClose={() => {}} onDone={done} />));
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    const btn = [...document.body.querySelectorAll('button')].find(b => b.textContent === 'Record payment')!;
    await act(async () => { btn.click(); });
    expect(calls.at(-1)?.[0]).toBe('pay_card_bill');
    expect(calls.at(-1)?.[1]).toMatchObject({ p_card: 'card1', p_from: 'bank1', p_amount: 200 });
    expect(done).toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('shows earmarks next to bank balances on the Accounts page', () => {
    const src = readFileSync('src/pages/SimplePages.tsx', 'utf8');
    expect(src).toContain('label="Earmarked for card bills"');
    expect(src).toContain("label: 'After card bills'");
  });
});
