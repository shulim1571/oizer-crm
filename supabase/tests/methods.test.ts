import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, OIZER, as, rows, seededDb } from './harness';

const sql = (db: PGlite, q: string, params: unknown[] = [], user = ADMIN) => as(db, user, tx => tx.query(q, params));
const one = async <T = Record<string, any>>(db: PGlite, q: string, params: unknown[] = [], user: string = ADMIN) => (await rows<T>(db, user, q, params))[0];
const svc = async (db: PGlite, q: string, params: unknown[] = []) => (await rows(db, 'service_role', q, params))[0];
const DONOR = { first_name: 'Chaim', last_name: 'Gold', phone: '(718) 555-0199', email: 'chaim@example.org' };
const ACH = { account_type: 'Checking', last4: '6789', name: 'Chaim Gold', agreed: true };
const pay = (db: PGlite, method: string, extra: { program?: string; ach?: object | null; amount?: number; cover?: boolean; recurring?: object | null } = {}) =>
  svc(db, `select public.begin_public_payment($1, '1001', $2, $3, $4, '{}', '9.9.9.9', $5, $6, $7, $8) r`,
    [OIZER, extra.amount ?? 100, extra.cover ?? false, JSON.stringify(DONOR), extra.recurring ? JSON.stringify(extra.recurring) : null, method,
     extra.program ?? null, extra.ach === undefined ? JSON.stringify(ACH) : extra.ach && JSON.stringify(extra.ach)]).then(x => x.r);
const answer = async (db: PGlite, id: string, result: object) => {
  const c = await svc(db, `select * from public.claim_gateway_request($1, $2)`, [OIZER, id]);
  return { claim: c, r: (await svc(db, `select public.record_gateway_result($1, $2, $3) r`, [OIZER, id, JSON.stringify(result)])).r };
};
const event = (db: PGlite, payload: object) => svc(db, `select public.record_gateway_event($1, $2)`, [OIZER, JSON.stringify(payload)]);

describe('bank accounts and DAF cards through Sola', () => {
  let base: PGlite;
  let db: PGlite;
  beforeAll(async () => {
    base = await seededDb();
    await base.query(`update public.org_members set role = 'super_admin' where user_id = $1`, [ADMIN]);
    await as(base, ADMIN, tx => tx.query(`select public.save_payment_settings('ifields_public', 'api_secret', null, true)`));
    await base.query(`update public.payment_methods set fee_type = 'percent', fee_percent = 3 where org_id = $1 and name = 'Credit Card'`, [OIZER]);
    await base.query(`update public.payment_methods set fee_type = 'flat', fee_flat = 1 where org_id = $1 and name = 'ACH'`, [OIZER]);
    await base.query(`update public.payment_methods set fee_type = 'percent', fee_percent = 5 where org_id = $1 and name = 'OJC Online'`, [OIZER]);
  });
  beforeEach(async () => { db = await base.clone(); });

  it('offer only the methods the Super Admin turns on', async () => {
    const page = async () => (await one(db, `select public.public_give_page($1, '1001') p`, [OIZER], 'anon')).p.payments;
    expect(await page()).toMatchObject({ ready: true, ach: false, daf: [], ach_authorization: null });
    await expect(pay(db, 'ach')).rejects.toThrow(/doesn't take bank payments/);
    await expect(pay(db, 'daf', { program: 'OJC' })).rejects.toThrow(/doesn't take that fund/);
    await sql(db, `select public.save_payment_options(true, '{OJC,Matbia}', null)`);
    const p = await page();
    expect(p).toMatchObject({ ach: true, daf: ['Matbia', 'OJC'] });
    expect(p.ach_authorization).toMatch(/^I authorize Oizer Umoshia to debit my bank account/);
    await expect(sql(db, `select public.save_payment_options(true, '{Fidelity}', null)`)).rejects.toThrow(/Choose from/);
    await db.query(`update public.org_members set role = 'admin' where user_id = $1`, [ADMIN]);
    await expect(sql(db, `select public.save_payment_options(false, '{}', null)`)).rejects.toThrow(/Only the Super Admin/);
  });

  it('record a bank debit with its authorization, then its return from the bank', async () => {
    await sql(db, `select public.save_payment_options(true, '{}', 'I, the donor, let {org} debit my account.')`);
    await expect(pay(db, 'ach', { ach: { ...ACH, agreed: false } })).rejects.toThrow(/agree to the ACH authorization/);
    await expect(pay(db, 'ach', { ach: { ...ACH, last4: '' } })).rejects.toThrow(/account number/);
    const v = await pay(db, 'ach', { cover: true });
    expect(Number(v.total)).toBe(101);
    const { claim, r } = await answer(db, v.id, { xResult: 'A', xRefNum: '3000001' });
    expect(claim).toMatchObject({ method: 'ach', account_type: 'Checking', amount: '101.00' });
    expect(r).toMatchObject({ status: 'approved', method: 'ach', settlement: 'pending', card_type: 'Checking', masked_card: 'xxxxx6789' });
    const g = (await db.query<{ ach_consent: any }>(`select ach_consent from public.gateway_transactions where id = $1`, [v.id])).rows[0];
    expect(g.ach_consent).toMatchObject({ wording: 'I, the donor, let Oizer Umoshia debit my account.', ip: '9.9.9.9', by: 'donor', last4: '6789' });
    const d = await one(db, `select status, payment_method, fee, notes from public.donations where id = $1`, [r.donation_id]);
    expect(d).toMatchObject({ status: 'completed', payment_method: 'ACH', fee: '1.00' });
    expect(d.notes).toContain('Checking account 6789');

    await event(db, { xRefNum: '3000001', xCommand: 'check:sale', xStatus: 'Settled' });
    expect((await db.query(`select settlement from public.gateway_transactions where id = $1`, [v.id])).rows[0]).toEqual({ settlement: 'settled' });
    await event(db, { xRefNum: '3000001', xCommand: 'check:sale', xStatus: 'Returned', xStatusReason: 'R01 - Insufficient Funds' });
    await event(db, { xRefNum: '3000001', xCommand: 'check:sale', xStatus: 'Returned', xStatusReason: 'R01 - Insufficient Funds' });
    expect(await one(db, `select status, reversal_reason, reversal_notes from public.donations where id = $1`, [r.donation_id]))
      .toEqual({ status: 'returned', reversal_reason: 'Bank returned the ACH debit', reversal_notes: 'R01 - Insufficient Funds · Sola ref 3000001' });
    const t = await one(db, `select task_type, summary from public.task_items where task_key = $1`, [`ach_returned:${r.donation_id}`]);
    expect(t).toEqual({ task_type: 'ach_returned', summary: 'Chaim Gold\'s bank returned $101.00 from Checking account 6789 · R01 - Insufficient Funds' });
  });

  it('take DAF grants under their own method, void them, and never refund them', async () => {
    await sql(db, `select public.save_payment_options(false, '{OJC}', null)`);
    const v = await pay(db, 'daf', { program: 'OJC', ach: null, cover: true });
    expect(Number(v.total)).toBe(105.26);
    const { claim, r } = await answer(db, v.id, { xResult: 'A', xRefNum: '4000001', xMaskedCardNumber: '6900xxxxxxxx2419', xCardType: 'OJC' });
    expect(claim).toMatchObject({ method: 'daf', daf_program: 'OJC' });
    const d = await one(db, `select payment_method, notes from public.donations where id = $1`, [r.donation_id]);
    expect(d.payment_method).toBe('OJC Online');
    expect(d.notes).toContain('OJC card 2419');
    await expect(sql(db, `select public.begin_card_reversal($1, 'refund')`, [r.donation_id])).rejects.toThrow(/can be voided but not refunded/);
    const voidId = (await one(db, `select public.begin_card_reversal($1, 'void') id`, [r.donation_id])).id;
    const vc = await answer(db, voidId, { xResult: 'A', xRefNum: '4000002' });
    expect(vc.claim).toMatchObject({ kind: 'void', method: 'daf', original_ref: '4000001' });
    expect((await one(db, `select status from public.donations where id = $1`, [r.donation_id])).status).toBe('voided');
    await expect(pay(db, 'daf', { program: 'OJC', ach: null, recurring: { frequency: 'monthly', start: '2099-01-01' } })).rejects.toThrow(/starts today/);
  });

  it('save a bank account from the office, and charge it on a schedule', async () => {
    await sql(db, `select public.save_payment_options(true, '{}', null)`);
    await expect(sql(db, `select public.begin_admin_save('daf', 'd1')`)).rejects.toThrow(/Only a card or a bank account/);
    const s = (await one(db, `select public.begin_admin_save('ach', 'd1', 'Donor One', '1.2.3.4', $1) id`, [JSON.stringify({ ...ACH, name: 'Donor One' })])).id;
    const saved = await answer(db, s, { xResult: 'A', xRefNum: '5000001', xToken: 'ach_tok', xMaskedAccountNumber: 'xxxxx6789' });
    expect(saved.r.card_id).toBeTruthy();
    expect(await one(db, `select method, card_type, masked, exp, name from public.donor_saved_cards('d1')`))
      .toEqual({ method: 'ach', card_type: 'Checking', masked: 'xxxxx6789', exp: null, name: 'Donor One' });
    const sale = (await one(db, `select public.begin_admin_payment('card', null, '1001', 'd1', 50, $1) id`, [saved.r.card_id])).id;
    expect((await answer(db, sale, { xResult: 'A', xRefNum: '5000002' })).claim).toMatchObject({ method: 'ach', card_token: 'ach_tok' });
    await sql(db, `select public.create_recurring('d1', '1001', $1, 25, 'monthly', public.org_today())`, [saved.r.card_id]);
    const [due] = await rows(db, 'service_role', `select method, card_token, amount from public.claim_recurring_charges(10)`);
    expect(due).toEqual({ method: 'ach', card_token: 'ach_tok', amount: '25.00' });
    await expect(sql(db, `select public.begin_admin_payment('ach', null, '1001', 'd1', 50, null, false, null, null, null, null, $1)`,
      [JSON.stringify({ ...ACH, agreed: false })])).rejects.toThrow(/agree to the ACH authorization/);
  });
});
