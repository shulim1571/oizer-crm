import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, MANAGER_1, OIZER, as, rows, seededDb } from './harness';

const sql = (db: PGlite, q: string, params: unknown[] = [], user = ADMIN) => as(db, user, tx => tx.query(q, params));
const one = async <T = Record<string, any>>(db: PGlite, q: string, params: unknown[] = [], user: string = ADMIN) => (await rows<T>(db, user, q, params))[0];
const svc = async (db: PGlite, q: string, params: unknown[] = []) => (await rows(db, 'service_role', q, params))[0];
const keys = (db: PGlite, api: string | null = 'sandbox_api_key', pin: string | null = 'pin0123456789abc') =>
  sql(db, `select public.save_payment_settings('ifields_public_key', $1, $2, true)`, [api, pin]);
const sale = async (db: PGlite, extra: { amount?: number; card?: string | null; save?: boolean; campaign?: string } = {}) =>
  (await one(db, `select public.begin_card_sale($1, 'd1', $2, $3, $4, 'Moshe Klein', 'mk@example.org', 'At the dinner', '1.2.3.4') id`,
    [extra.campaign ?? '1001', extra.amount ?? 180, extra.card ?? null, extra.save ?? false])).id as string;
const APPROVED = { xResult: 'A', xStatus: 'Approved', xRefNum: '1000001', xAuthCode: 'ABC123', xMaskedCardNumber: '4xxxxxxxxxxx1111', xCardType: 'Visa', xExp: '1230', xToken: 'tok_abc' };
const finish = (db: PGlite, id: string, result: object) => svc(db, `select public.record_gateway_result($1, $2, $3) r`, [OIZER, id, JSON.stringify(result)]);

describe('card payments through Sola', () => {
  let base: PGlite;
  let db: PGlite;
  beforeAll(async () => {
    base = await seededDb();
    // The seed's admin runs the office; make them the Super Admin who holds the keys.
    await base.query(`update public.org_members set role = 'super_admin' where user_id = $1`, [ADMIN]);
  });
  beforeEach(async () => { db = await base.clone(); });

  it('keep the API key and PIN encrypted, and show only whether they are set', async () => {
    await expect(sale(db)).rejects.toThrow(/aren't set up yet/);
    await keys(db);
    expect(await one(db, `select ifields_key, sandbox, api_key_set, pin_set from public.payment_config()`))
      .toEqual({ ifields_key: 'ifields_public_key', sandbox: true, api_key_set: true, pin_set: true });
    const raw = (await db.query<{ k: string }>(`select encode(api_key, 'escape') k from public.payment_settings`)).rows[0];
    expect(raw.k).not.toContain('sandbox_api_key');
    await sql(db, `select public.save_payment_settings('ifields_public_key', null, null, true)`);
    expect((await svc(db, `select api_key from public.claim_gateway_request($1, $2)`, [OIZER, await sale(db)])).api_key).toBe('sandbox_api_key');
    expect((await svc(db, `select public.gateway_webhook_pin($1) p`, [OIZER])).p).toBe('pin0123456789abc');
    await expect(keys(db, 'x', 'short')).rejects.toThrow(/at least 15 letters and numbers/);
    await expect(rows(db, ADMIN, `select * from public.payment_settings`)).rejects.toThrow();
  });

  it('let only the Super Admin set keys, and only admins charge', async () => {
    await db.query(`update public.org_members set role = 'admin' where user_id = $1`, [ADMIN]);
    await expect(keys(db)).rejects.toThrow(/Only the Super Admin/);
    await db.query(`update public.org_members set role = 'super_admin' where user_id = $1`, [ADMIN]);
    await keys(db);
    await expect(sql(db, `select public.begin_card_sale('1001', 'd1', 10)`, [], MANAGER_1)).rejects.toThrow();
    await expect(rows(db, MANAGER_1, `select * from public.payment_config()`)).resolves.toEqual([]);
  });

  it('turn an approved charge into a completed donation, under the admin\'s name', async () => {
    await keys(db);
    const id = await sale(db);
    const c = await svc(db, `select * from public.claim_gateway_request($1, $2)`, [OIZER, id]);
    expect(c).toMatchObject({ kind: 'sale', amount: '180.00', card_token: null, campaign_label: 'First campaign (1001)' });
    expect(c.invoice).toMatch(/^OZ[0-9A-F]{12}$/);
    await expect(svc(db, `select * from public.claim_gateway_request($1, $2)`, [OIZER, id])).rejects.toThrow(/already sent/);
    const r = (await finish(db, id, APPROVED)).r;
    expect(r).toMatchObject({ status: 'approved', ref_num: '1000001', masked_card: '4xxxxxxxxxxx1111' });
    const d = await one(db, `select status, amount, payment_method, gateway_id, created_by, notes, fee from public.donations where id = $1`, [r.donation_id]);
    expect(d).toMatchObject({ status: 'completed', amount: '180.00', payment_method: 'Credit Card', gateway_id: '1000001', created_by: 'office@example.org' });
    expect(d.notes).toBe('At the dinner · Visa 1111');
    expect(Number(d.fee)).toBeGreaterThanOrEqual(0);
    expect((await finish(db, id, { xResult: 'D' })).r.status).toBe('approved');
    expect(await one(db, `select response from public.gateway_transactions where id = $1`, [id], 'service_role')).not.toHaveProperty('response.xToken');
  });

  it('keep a decline as a failed transaction that doesn\'t count', async () => {
    await keys(db);
    const before = await one(db, `select balance from public.campaign_summary where id = '1001'`);
    const id = await sale(db, { amount: 9.91 });
    await svc(db, `select * from public.claim_gateway_request($1, $2)`, [OIZER, id]);
    const r = (await finish(db, id, { xResult: 'D', xStatus: 'Declined', xError: 'Insufficient funds', xErrorCode: '01334', xMaskedCardNumber: '4xxxxxxxxxxx1111', xCardType: 'Visa' })).r;
    expect(r).toMatchObject({ status: 'declined', error: 'Insufficient funds' });
    expect(await one(db, `select status, notes from public.donations where id = $1`, [r.donation_id]))
      .toEqual({ status: 'failed', notes: 'At the dinner · Visa 1111 · Declined: Insufficient funds' });
    expect(await one(db, `select balance from public.campaign_summary where id = '1001'`)).toEqual(before);
  });

  it('give a failed charge no fee, however it is saved, and leave real charges alone', async () => {
    await keys(db);
    const id = await sale(db, { amount: 9.91 });
    await svc(db, `select * from public.claim_gateway_request($1, $2)`, [OIZER, id]);
    const r = (await finish(db, id, { xResult: 'D', xError: 'Insufficient funds', xMaskedCardNumber: '4xxxxxxxxxxx1111', xCardType: 'Visa' })).r;
    // Credit Card carries a percentage fee, so before the fix this decline had one.
    expect(await one(db, `select fee::text, manual_fee, net_donation::text from public.donations where id = $1`, [r.donation_id]))
      .toEqual({ fee: '0.00', manual_fee: null, net_donation: '0.00' });
    // Saved by hand as failed, with a fee typed in: still none.
    await sql(db, `insert into public.donations (id, campaign_id, type, status, amount, fee, manual_fee, payment_method) values ('fx', '1001', 'Payment', 'failed', 100, 3.5, 2, 'Credit Card')`);
    expect(await one(db, `select fee::text, manual_fee, net_donation::text from public.donations where id = 'fx'`)).toEqual({ fee: '0.00', manual_fee: null, net_donation: '0.00' });
    // Edited to add one later: refused quietly.
    await sql(db, `update public.donations set fee = 4 where id = 'fx'`);
    expect((await one(db, `select fee::text from public.donations where id = 'fx'`)).fee).toBe('0.00');
    // A completed gift keeps its fee, and one that turns out to have gone through gets its net back.
    await sql(db, `update public.donations set status = 'completed', fee = 2.90 where id = 'fx'`);
    expect(await one(db, `select fee::text, net_donation::text from public.donations where id = 'fx'`)).toEqual({ fee: '2.90', net_donation: '97.10' });
    // A completed gift that fails afterwards loses its fee, and its fees leave the campaign totals.
    const fees = async () => Number((await one(db, `select fees from public.campaign_summary where id = '1001'`)).fees);
    const withFee = await fees();
    await sql(db, `update public.donations set status = 'failed' where id = 'fx'`);
    expect(await fees()).toBeCloseTo(withFee - 2.9, 2);
  });

  it('save the card on the donor when asked, and charge it again later', async () => {
    await keys(db);
    const id = await sale(db, { save: true });
    await svc(db, `select * from public.claim_gateway_request($1, $2)`, [OIZER, id]);
    await finish(db, id, APPROVED);
    const [card] = await rows(db, ADMIN, `select * from public.donor_saved_cards('d1')`);
    expect(card).toMatchObject({ masked: '4xxxxxxxxxxx1111', card_type: 'Visa', exp: '1230', name: 'Moshe Klein' });
    const again = await sale(db, { card: card.id, amount: 36 });
    expect((await svc(db, `select card_token from public.claim_gateway_request($1, $2)`, [OIZER, again])).card_token).toBe('tok_abc');
    await expect(one(db, `select public.begin_card_sale('1001', 'd2', 5, $1) id`, [card.id])).rejects.toThrow(/isn't on this donor/);
    await sql(db, `select public.delete_donor_card($1)`, [card.id]);
    expect(await rows(db, ADMIN, `select * from public.donor_saved_cards('d1')`)).toEqual([]);
    expect(await rows(db, MANAGER_1, `select * from public.donor_saved_cards('d1')`)).toEqual([]);
  });

  it('void or refund only through Sola, and only once', async () => {
    await keys(db);
    const id = await sale(db);
    await svc(db, `select * from public.claim_gateway_request($1, $2)`, [OIZER, id]);
    const donation = (await finish(db, id, APPROVED)).r.donation_id;
    const v = (await one(db, `select public.begin_card_reversal($1, 'void') id`, [donation])).id;
    expect((await svc(db, `select original_ref from public.claim_gateway_request($1, $2)`, [OIZER, v])).original_ref).toBe('1000001');
    await expect(one(db, `select public.begin_card_reversal($1, 'refund') id`, [donation])).rejects.toThrow(/already being voided/);
    await finish(db, v, { xResult: 'A', xRefNum: '1000002' });
    expect(await one(db, `select status, reversal_reason from public.donations where id = $1`, [donation])).toEqual({ status: 'voided', reversal_reason: 'Voided at Sola' });
    await expect(one(db, `select public.begin_card_reversal($1, 'refund') id`, [donation])).rejects.toThrow(/Only a completed payment/);
    expect((await rows(db, ADMIN, `select kind, status from public.donation_gateway($1)`, [donation])).map(x => `${x.kind}:${x.status}`)).toEqual(['sale:approved', 'void:approved']);
  });

  it('refund a settled payment, keeping the fee spent', async () => {
    await keys(db);
    const id = await sale(db);
    await svc(db, `select * from public.claim_gateway_request($1, $2)`, [OIZER, id]);
    const donation = (await finish(db, id, APPROVED)).r.donation_id;
    const r = (await one(db, `select public.begin_card_reversal($1, 'refund') id`, [donation])).id;
    await svc(db, `select * from public.claim_gateway_request($1, $2)`, [OIZER, r]);
    await finish(db, r, { xResult: 'A', xRefNum: '1000003' });
    expect(await one(db, `select status, reversal_method from public.donations where id = $1`, [donation])).toEqual({ status: 'refunded', reversal_method: 'Credit Card' });
    await expect(one(db, `select public.begin_card_reversal('p1', 'refund') id`)).rejects.toThrow(/didn't go through Sola/);
  });

  it('refuse to mark a Sola charge refunded without Sola', async () => {
    await keys(db);
    const id = await sale(db);
    await svc(db, `select * from public.claim_gateway_request($1, $2)`, [OIZER, id]);
    const donation = (await finish(db, id, APPROVED)).r.donation_id;
    await expect(sql(db, `select public.refund_donation($1)`, [donation])).rejects.toThrow(/Use Refund at Sola/);
    await sql(db, `select public.refund_donation('p1')`);
    expect((await one(db, `select status from public.donations where id = 'p1'`)).status).toBe('refunded');
  });

  it('let Sola\'s webhook finish a charge whose answer was lost, once', async () => {
    await keys(db);
    const id = await sale(db);
    const c = await svc(db, `select invoice from public.claim_gateway_request($1, $2)`, [OIZER, id]);
    await db.query(`update public.gateway_transactions set attempted_at = now() - interval '5 minutes' where id = $1`, [id]);
    const payload = { xCommand: 'cc:sale', xRefNum: '1000009', xInvoice: c.invoice, xResponseResult: 'Approved', xAmount: '180.00', xMaskedCardNumber: '4xxxxxxxxxxx1111', xCardType: 'Visa' };
    await svc(db, `select public.record_gateway_event($1, $2)`, [OIZER, JSON.stringify(payload)]);
    await svc(db, `select public.record_gateway_event($1, $2)`, [OIZER, JSON.stringify(payload)]);
    const g = await one(db, `select status, ref_num, donation_id from public.gateway_transactions where id = $1`, [id]);
    expect(g).toMatchObject({ status: 'approved', ref_num: '1000009' });
    expect((await db.query(`select 1 from public.gateway_events`)).rows).toHaveLength(1);
    expect((await db.query(`select 1 from public.donations where gateway_id = '1000009'`)).rows).toHaveLength(1);
  });

  it('refuse bad charges', async () => {
    await keys(db);
    await expect(sale(db, { amount: 0 })).rejects.toThrow(/Enter an amount/);
    await expect(sale(db, { amount: 100001 })).rejects.toThrow(/up to \$100,000/);
    await db.query(`update public.campaigns set status = 'closed' where id = '1002'`);
    await expect(sale(db, { campaign: '1002' })).rejects.toThrow(/closed/);
  });
});
