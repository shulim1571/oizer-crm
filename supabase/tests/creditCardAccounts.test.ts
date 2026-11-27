import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, MANAGER_1, OIZER, rows, seededDb } from './harness';

// Credit cards as accounts (Moshe, 2026-11-20), sample data only: card payouts recorded against the card, what's owed
// shown next to the bank that pays it as earmarked, and the bill paid as one bank-to-card transfer.
const q = <T = Record<string, any>>(db: PGlite, sql: string, params: unknown[] = [], who = ADMIN) => rows<T>(db, who, sql, params, OIZER);
const summary = async (db: PGlite, id: string) => (await q(db, `select * from public.account_summary where id = $1`, [id]))[0];
const n = (v: unknown) => (v == null ? null : Number(v));

describe('credit card accounts', () => {
  let base: PGlite;
  let db: PGlite;
  beforeAll(async () => {
    base = await seededDb();
    await base.exec(`insert into public.accounts (org_id, id, name) values ('${OIZER}', 'bank1', 'Sample Operating');
      insert into public.accounts (org_id, id, name, kind, card_last4, pays_from_account_id, bill_due_day) values ('${OIZER}', 'card1', 'Sample Card', 'credit_card', '4242', 'bank1', 15);`);
  });
  beforeEach(async () => { db = await base.clone(); });

  it('records a payout charged to a card as a card payout against the card, off the campaign like any payout', async () => {
    const before = n((await q(db, `select balance from public.campaign_summary where id = '1001'`))[0].balance)!;
    const [{ id }] = await q<{ id: string }>(db, `insert into public.expenses (campaign_id, amount, payee, method, account_id, check_number) values ('1001', 120, 'Sample Vendor', 'Check', 'card1', '555') returning id`);
    expect((await q(db, `select method, check_number, account_id from public.expenses where id = $1`, [id]))[0]).toEqual({ method: 'Credit Card', check_number: null, account_id: 'card1' });
    expect(n((await q(db, `select balance from public.campaign_summary where id = '1001'`))[0].balance)).toBeCloseTo(before - 120, 2);
    expect(n((await summary(db, 'card1')).card_owed)).toBe(120);
  });

  it('shows what the cards owe next to the bank that pays them, and paying the bill moves it with one transfer', async () => {
    await db.query(`insert into public.donations (org_id, id, campaign_id, type, status, amount, payment_method, account_id) values ($1, 'cc-in', '1001', 'Payment', 'completed', 1000, 'Cash', 'bank1')`, [OIZER]);
    await q(db, `insert into public.expenses (campaign_id, amount, payee, method, account_id) values ('1001', 120, 'Sample Vendor', 'Credit Card', 'card1'), ('1001', 80, 'Sample Vendor 2', 'Credit Card', 'card1')`);
    let bank = await summary(db, 'bank1');
    expect([n(bank.book_balance), n(bank.earmarked_for_cards), n(bank.available_after_cards)]).toEqual([1000, 200, 800]);
    const campaignBefore = n((await q(db, `select balance from public.campaign_summary where id = '1001'`))[0].balance);
    const [{ id }] = await q<{ id: string }>(db, `select public.pay_card_bill('card1', 'bank1', 150, '2026-11-20', 'Sample ref') id`);
    bank = await summary(db, 'bank1');
    expect([n(bank.book_balance), n(bank.earmarked_for_cards), n(bank.available_after_cards), n(bank.transfers_out)]).toEqual([850, 50, 800, 150]);
    expect(n((await summary(db, 'card1')).card_owed)).toBe(50);
    expect(n((await q(db, `select balance from public.campaign_summary where id = '1001'`))[0].balance)).toBe(campaignBefore);   // no campaign touched
    // Undo it.
    await q(db, `select public.delete_account_transfer($1)`, [id]);
    expect(n((await summary(db, 'card1')).card_owed)).toBe(200);
  });

  it('checks the accounts and keeps bill payments to admins', async () => {
    await expect(q(db, `select public.pay_card_bill('bank1', 'bank1', 10)`)).rejects.toThrow(/card whose bill/);
    await expect(q(db, `select public.pay_card_bill('card1', 'card1', 10)`)).rejects.toThrow(/bank account it was paid from/);
    await expect(q(db, `select public.pay_card_bill('card1', 'bank1', 0)`)).rejects.toThrow(/amount/);
    await expect(q(db, `select public.pay_card_bill('card1', 'bank1', 10)`, [], MANAGER_1)).rejects.toThrow();
    await expect(q(db, `update public.accounts set pays_from_account_id = 'card1' where id = 'card1'`)).rejects.toThrow(/bank account/);
    // A bank account keeps no card details.
    await q(db, `update public.accounts set card_last4 = '1111', bill_due_day = 3 where id = 'bank1'`);
    expect((await q(db, `select card_last4, bill_due_day from public.accounts where id = 'bank1'`))[0]).toEqual({ card_last4: null, bill_due_day: null });
  });
});
