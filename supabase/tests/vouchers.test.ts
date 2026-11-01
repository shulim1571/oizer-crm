import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, MANAGER_1, MANAGER_2, as, rows, seededDb } from './harness';

const summary = async (db: PGlite, id: string) =>
  (await rows<Record<string, string>>(db, ADMIN, `select * from public.campaign_summary where id = $1`, [id]))[0];
const voucher = async (db: PGlite, id: string) =>
  (await rows<Record<string, any>>(db, ADMIN, `select * from public.voucher_list where id = $1`, [id]))[0];
const pledge = async (db: PGlite, id: string) =>
  (await rows<Record<string, any>>(db, ADMIN, `select * from public.pledge_list where id = $1`, [id]))[0];
const schedule = (db: PGlite, id: string) =>
  rows<Record<string, any>>(db, ADMIN, `select * from public.installment_list where pledge_id = $1 order by seq`, [id]);
const insert = async (db: PGlite, user: string, table: string, values: Record<string, unknown>) => {
  const keys = Object.keys(values);
  const [r] = await rows<{ id: string }>(db, user,
    `insert into public.${table} (${keys.join(',')}) values (${keys.map((_, i) => `$${i + 1}`).join(',')}) returning id`, Object.values(values));
  return r.id;
};
const logVoucher = (db: PGlite, values: Record<string, unknown> = {}) =>
  insert(db, ADMIN, 'vouchers', { campaign_id: '1003', issuer: 'Voucher — OJC Fund', face_value: 1000, fee_type: 'percent', fee_percent: 5, ...values });
const fund = async (db: PGlite, id: string, amount: number, extra = 'null, null, null') =>
  (await rows<{ r: { ok: boolean; donation_id: string; remaining: string } }>(db, ADMIN, `select public.add_voucher_funding($1, $2, ${extra}) as r`, [id, amount]))[0].r;
const pay = async (db: PGlite, values: Record<string, unknown>) =>
  insert(db, ADMIN, 'donations', { campaign_id: '1003', donor_id: 'd1', amount: 100, payment_method: 'Cash', type: 'Payment', status: 'completed', ...values });
const addPledge = (db: PGlite, values: Record<string, unknown> = {}, user = ADMIN) =>
  insert(db, user, 'pledges', { campaign_id: '1003', donor_id: 'd1', amount: 500, ...values });
const addRecurring = (db: PGlite, values: Record<string, unknown> = {}) =>
  addPledge(db, { is_recurring: true, installment_amount: 500, frequency: 'monthly', start_date: '2030-01-31', installment_count: 12, ...values });

describe('vouchers', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); });

  it('get a numbered reference and take nothing from the balance until funded', async () => {
    const before = await summary(db, '1003');
    const id = await logVoucher(db);
    expect(id).toMatch(/^VCH-\d{4}-00001$/);
    expect(await logVoucher(db)).toMatch(/^VCH-\d{4}-00002$/);
    const after = await summary(db, '1003');
    expect(after.balance).toBe(before.balance);
    expect(after.awaiting_funds).toBe('2000.00');
    expect(await voucher(db, id)).toMatchObject({ status: 'pending', remaining: '1000.00', total_funded: '0' });
  });

  it("match the spec's example: $1000 at 5%, funded 400, 350, 250", async () => {
    const id = await logVoucher(db);
    const before = Number((await summary(db, '1003')).balance);
    await fund(db, id, 400);
    expect(await voucher(db, id)).toMatchObject({ status: 'partial', total_funded: '400.00', total_fees: '20.00', total_net: '380.00', remaining: '600.00', percent_funded: '40.0' });
    await fund(db, id, 350);
    expect(await voucher(db, id)).toMatchObject({ total_funded: '750.00', total_fees: '37.50', total_net: '712.50', remaining: '250.00' });
    await fund(db, id, 250);
    expect(await voucher(db, id)).toMatchObject({ status: 'funded', total_funded: '1000.00', total_fees: '50.00', total_net: '950.00', remaining: '0.00', percent_funded: '100.0' });
    const after = await summary(db, '1003');
    expect(Number(after.balance)).toBe(before + 950);
    expect(Number(after.awaiting_funds)).toBe(0);
  });

  it('take the fee from the issuer when none is entered', async () => {
    await as(db, ADMIN, tx => tx.query(`update public.payment_methods set fee_type = 'flat', fee_flat = 7 where name = 'Voucher — Matbia'`));
    const id = await insert(db, ADMIN, 'vouchers', { campaign_id: '1003', issuer: 'Voucher — Matbia', face_value: 100 });
    expect(await voucher(db, id)).toMatchObject({ fee_type: 'flat', fee_flat: '7.00' });
    await fund(db, id, 40);
    expect((await voucher(db, id)).total_net).toBe('33.00');
  });

  it('allow a fee larger than the funding, and an adjusted fee', async () => {
    const id = await logVoucher(db, { fee_type: 'flat', fee_percent: 0, fee_flat: 7 });
    await fund(db, id, 5);
    expect((await voucher(db, id)).total_net).toBe('-2.00');
    await fund(db, id, 5, 'null, null, 1');
    expect((await voucher(db, id)).total_fees).toBe('8.00');
  });

  it('refuse going over the face value, and flag it for review', async () => {
    const id = await logVoucher(db);
    await fund(db, id, 900);
    const r = await fund(db, id, 200);
    expect(r).toMatchObject({ ok: false });
    expect(Number(r.remaining)).toBe(100);
    expect(await voucher(db, id)).toMatchObject({ status: 'overage_review', total_funded: '900.00' });
    await fund(db, id, 100);
    expect((await voucher(db, id)).status).toBe('funded');
  });

  it('reactivate an archived campaign, and leave a closed one unattributed', async () => {
    const a = await logVoucher(db);
    await as(db, ADMIN, tx => tx.query(`update public.campaigns set status = 'archived' where id = '1003'`));
    await fund(db, a, 100);
    expect((await summary(db, '1003')).status).toBe('active');
    await as(db, ADMIN, tx => tx.query(`update public.campaigns set status = 'closed' where id = '1003'`));
    const raised = (await summary(db, '1003')).raised;
    const r = await fund(db, a, 100);
    const [d] = await rows<Record<string, any>>(db, ADMIN, `select campaign_id, notes, net_donation from public.donations where id = $1`, [r.donation_id]);
    expect(d).toMatchObject({ campaign_id: null, net_donation: '95.00' });
    expect(d.notes).toMatch(/closed/);
    expect((await summary(db, '1003')).raised).toBe(raised);
    expect((await voucher(db, a)).total_funded).toBe('200.00');
  });

  it("can't be logged on a closed campaign", async () => {
    await as(db, ADMIN, tx => tx.query(`update public.campaigns set status = 'closed' where id = '1003'`));
    await expect(logVoucher(db)).rejects.toThrow(/closed/);
  });

  it('keep the fee, campaign and funded money fixed once funds arrive', async () => {
    const id = await logVoucher(db);
    await fund(db, id, 100);
    await expect(as(db, ADMIN, tx => tx.query(`update public.vouchers set fee_percent = 1 where id = $1`, [id]))).rejects.toThrow(/set once/);
    await expect(as(db, ADMIN, tx => tx.query(`update public.vouchers set campaign_id = '1001' where id = $1`, [id]))).rejects.toThrow(/can't be moved/);
    await expect(as(db, ADMIN, tx => tx.query(`update public.vouchers set face_value = 50 where id = $1`, [id]))).rejects.toThrow(/less than/);
    await expect(as(db, ADMIN, tx => tx.query(`delete from public.vouchers where id = $1`, [id]))).rejects.toThrow(/funding/);
    await as(db, ADMIN, tx => tx.query(`update public.vouchers set expected_date = '2031-01-01', face_value = 900 where id = $1`, [id]));
  });

  it('reopen the funded part when a funding entry is refunded', async () => {
    const id = await logVoucher(db);
    const r = await fund(db, id, 1000);
    await as(db, ADMIN, tx => tx.query(`select public.refund_donation($1)`, [r.donation_id]));
    expect(await voucher(db, id)).toMatchObject({ status: 'pending', remaining: '1000.00' });
  });

  it('come off the awaiting total when cancelled, keeping what arrived', async () => {
    const id = await logVoucher(db);
    await fund(db, id, 100);
    await expect(as(db, ADMIN, tx => tx.query(`select public.cancel_voucher($1, ' ')`, [id]))).rejects.toThrow(/reason/);
    await as(db, ADMIN, tx => tx.query(`select public.cancel_voucher($1, 'Issuer refused')`, [id]));
    expect(await voucher(db, id)).toMatchObject({ status: 'cancelled', total_funded: '100.00', remaining: '0' });
    expect((await summary(db, '1003')).awaiting_funds).toBe('0');
    await expect(fund(db, id, 10)).rejects.toThrow(/cancelled/);
  });

  it('keep an account number only for mailed-in vouchers', async () => {
    const online = await logVoucher(db, { account_number: '123' });
    const mailed = await logVoucher(db, { submission: 'mailed', account_number: '123' });
    expect((await voucher(db, online)).account_number).toBeNull();
    expect((await voucher(db, mailed)).account_number).toBe('123');
  });

  it('flag as overdue past the expected date, or after 30 days with none', async () => {
    expect((await voucher(db, await logVoucher(db, { expected_date: '2020-01-01' }))).overdue).toBe(true);
    expect((await voucher(db, await logVoucher(db, { date_received: '2020-01-01' }))).overdue).toBe(true);
    expect((await voucher(db, await logVoucher(db, { expected_date: '2099-01-01', date_received: '2020-01-01' }))).overdue).toBe(false);
  });

  it('are admin only to change, and fundraisers see only their own', async () => {
    const id = await logVoucher(db);
    const other = await logVoucher(db, { campaign_id: '1002' });
    await expect(insert(db, MANAGER_1, 'vouchers', { campaign_id: '1003', issuer: 'Voucher — OJC Fund', face_value: 10 })).rejects.toThrow();
    await expect(as(db, MANAGER_1, tx => tx.query(`select public.add_voucher_funding($1, 10)`, [id]))).rejects.toThrow(/Only admins/);
    expect((await rows<{ id: string }>(db, MANAGER_1, `select id from public.voucher_list`)).map(r => r.id)).toEqual([id]);
    expect((await rows(db, MANAGER_2, `select id from public.voucher_list order by id`)).length).toBe(2);
    expect(other).toBeTruthy();
  });

  it('are hidden when deleted and can be restored', async () => {
    const id = await logVoucher(db);
    await as(db, ADMIN, tx => tx.query(`delete from public.vouchers where id = $1`, [id]));
    expect(await voucher(db, id)).toBeUndefined();
    expect((await summary(db, '1003')).awaiting_funds).toBe('0');
    await as(db, ADMIN, tx => tx.query(`select public.restore_record('vouchers', $1)`, [id]));
    expect(await voucher(db, id)).toBeTruthy();
  });
});

describe('pledges', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); });

  it('keep existing ones, with a reference and their own date', async () => {
    const g = await pledge(db, 'g1');
    expect(g).toMatchObject({ amount: '500.00', status: 'open', received: '0', balance: '500.00' });
    expect(g.reference).toMatch(/^PLG-\d{4}-00001$/);
  });

  it('show as pledged, never in the balance', async () => {
    const before = await summary(db, '1003');
    await addPledge(db);
    const after = await summary(db, '1003');
    expect(after.balance).toBe(before.balance);
    expect(after.raised).toBe(before.raised);
    expect(after.pledged_open).toBe('500.00');
  });

  it('are fulfilled by a payment matching donor, campaign and amount', async () => {
    const id = await addPledge(db);
    const d = await pay(db, { amount: 500 });
    expect(await pledge(db, id)).toMatchObject({ status: 'fulfilled', received: '500.00', balance: '0.00' });
    const [link] = await rows<Record<string, any>>(db, ADMIN, `select donation_id, matched_by from public.pledge_payments where pledge_id = $1`, [id]);
    expect(link).toEqual({ donation_id: d, matched_by: 'auto' });
    expect(Number((await summary(db, '1003')).pledged_open)).toBe(0);
  });

  it('go partial on a smaller payment, with the rest still open', async () => {
    const id = await addPledge(db);
    await pay(db, { amount: 200 });
    expect(await pledge(db, id)).toMatchObject({ status: 'partial', received: '200.00', balance: '300.00' });
    expect((await summary(db, '1003')).pledged_open).toBe('300.00');
  });

  it('ignore other donors, campaigns, bigger payments and payments with no donor', async () => {
    const id = await addPledge(db);
    await pay(db, { amount: 500, donor_id: 'd2' });
    await pay(db, { amount: 500, campaign_id: '1002' });
    await pay(db, { amount: 900 });
    await pay(db, { amount: 500, donor_id: null });
    expect((await pledge(db, id)).received).toBe('0');
  });

  it('prefer the pledge the amount matches exactly over an older one', async () => {
    const older = await addPledge(db, { amount: 900, date_pledged: '2020-01-01' });
    const exact = await addPledge(db, { amount: 300, date_pledged: '2025-01-01' });
    await pay(db, { amount: 300 });
    expect((await pledge(db, exact)).status).toBe('fulfilled');
    expect((await pledge(db, older)).received).toBe('0');
  });

  it('wait for a payment to count: pending and post-dated match when they become real', async () => {
    const id = await addPledge(db);
    const d = await pay(db, { amount: 500, post_dated: true, check_date: '2099-01-01' });
    expect((await pledge(db, id)).received).toBe('0');
    await as(db, ADMIN, tx => tx.query(`update public.donations set status = 'completed' where id = $1`, [d]));
    expect((await pledge(db, id)).status).toBe('fulfilled');
  });

  it('match voucher funding too', async () => {
    const id = await addPledge(db, { amount: 100 });
    const v = await insert(db, ADMIN, 'vouchers', { campaign_id: '1003', donor_id: 'd1', issuer: 'Voucher — OJC Fund', face_value: 100, fee_type: 'percent', fee_percent: 5 });
    await fund(db, v, 100);
    expect((await pledge(db, id)).status).toBe('fulfilled');
  });

  it('stay fulfilled when the payment is later refunded', async () => {
    const id = await addPledge(db);
    const d = await pay(db, { amount: 500 });
    await as(db, ADMIN, tx => tx.query(`select public.refund_donation($1)`, [d]));
    expect((await pledge(db, id)).status).toBe('fulfilled');
  });

  it('protect a matched payment from being split or shrunk until unmatched', async () => {
    const id = await addPledge(db);
    const d = await pay(db, { amount: 500 });
    await expect(as(db, ADMIN, tx => tx.query(`select public.split_donation($1, $2::jsonb)`, [d, JSON.stringify([{ campaign_id: '1003', amount: 300 }, { campaign_id: '1002', amount: 200 }])]))).rejects.toThrow(/Unmatch/);
    await as(db, ADMIN, tx => tx.query(`select public.unmatch_pledge_payment($1, $2)`, [id, d]));
    expect((await pledge(db, id)).status).toBe('open');
    await as(db, ADMIN, tx => tx.query(`select public.split_donation($1, $2::jsonb)`, [d, JSON.stringify([{ campaign_id: '1003', amount: 300 }, { campaign_id: '1002', amount: 200 }])]));
  });

  it('can be matched by hand, on the same campaign, up to what is owed', async () => {
    const id = await addPledge(db, { donor_id: null, name: 'Moshe' });
    const d = await pay(db, { amount: 900 });
    await as(db, ADMIN, tx => tx.query(`select public.match_pledge_payment($1, $2)`, [id, d]));
    expect(await pledge(db, id)).toMatchObject({ status: 'fulfilled', received: '500.00' });
    await expect(as(db, ADMIN, tx => tx.query(`select public.match_pledge_payment($1, $2)`, [id, d]))).rejects.toThrow(/Nothing is left/);
    const elsewhere = await pay(db, { campaign_id: '1002', donor_id: null });
    const open = await addPledge(db, { donor_id: null });
    await expect(as(db, ADMIN, tx => tx.query(`select public.match_pledge_payment($1, $2)`, [open, elsewhere]))).rejects.toThrow(/different campaign/);
  });

  it('are paid from the pledge itself, even at a different amount', async () => {
    const id = await addPledge(db, { donor_id: null, name: 'Moshe', amount: 500 });
    const [{ d }] = await rows<{ d: string }>(db, ADMIN, `select public.pay_pledge($1, 200, 'Cash') as d`, [id]);
    expect(await pledge(db, id)).toMatchObject({ status: 'partial', received: '200.00' });
    const [row] = await rows<Record<string, any>>(db, ADMIN, `select name, campaign_id, status from public.donations where id = $1`, [d]);
    expect(row).toEqual({ name: 'Moshe', campaign_id: '1003', status: 'completed' });
  });

  it('let a fundraiser pay only with the override, and count it on approval', async () => {
    const id = await addPledge(db);
    await expect(as(db, MANAGER_1, tx => tx.query(`select public.pay_pledge($1, 500, 'Cash')`, [id]))).rejects.toThrow(/permission/);
    await as(db, ADMIN, tx => tx.query(`select public.grant_override('m1', 'enter_manual_payments', array['1003'])`));
    const [{ d }] = await rows<{ d: string }>(db, MANAGER_1, `select public.pay_pledge($1, 500, 'Cash') as d`, [id]);
    expect((await rows<Record<string, any>>(db, ADMIN, `select status from public.donations where id = $1`, [d]))[0].status).toBe('pending');
    expect((await pledge(db, id)).received).toBe('0');
    await as(db, ADMIN, tx => tx.query(`select public.review_donation($1, true)`, [d]));
    expect((await pledge(db, id)).status).toBe('fulfilled');
  });

  it('go overdue past the expected date with no payment', async () => {
    expect((await pledge(db, await addPledge(db, { expected_date: '2020-01-01' }))).status).toBe('overdue');
    expect((await pledge(db, await addPledge(db, { expected_date: '2099-01-01' }))).status).toBe('open');
  });

  it('can be cancelled with a reason, kept in history', async () => {
    const id = await addPledge(db);
    await expect(as(db, ADMIN, tx => tx.query(`select public.cancel_pledge($1, '')`, [id]))).rejects.toThrow(/reason/);
    await as(db, ADMIN, tx => tx.query(`select public.cancel_pledge($1, 'Withdrawn')`, [id]));
    expect(await pledge(db, id)).toMatchObject({ status: 'cancelled', cancel_reason: 'Withdrawn' });
    expect((await summary(db, '1003')).pledged_open).toBe('0');
    await pay(db, { amount: 500 });
    expect((await pledge(db, id)).received).toBe('0');
  });

  it('take notes and become tasks from a fundraiser on the campaign', async () => {
    const id = await addPledge(db);
    await as(db, MANAGER_1, tx => tx.query(`select public.add_pledge_note($1, 'called twice')`, [id]));
    expect((await pledge(db, id)).notes).toMatch(/one@example.org: called twice/);
    const [{ t }] = await rows<{ t: string }>(db, MANAGER_1, `select public.pledge_to_task($1) as t`, [id]);
    const [task] = await rows<Record<string, any>>(db, ADMIN, `select title, campaign_id from public.tasks where id = $1`, [t]);
    expect(task.title).toMatch(/Follow up on pledge PLG-.*: Donor One \$500\.00/);
  });

  it('are entered by fundraisers on their own campaigns only, and read the same way', async () => {
    const mine = await addPledge(db, {}, MANAGER_1);
    await expect(addPledge(db, { campaign_id: '1002' }, MANAGER_1)).rejects.toThrow();
    expect((await rows<{ id: string }>(db, MANAGER_1, `select id from public.pledge_list where campaign_id = '1003'`)).map(r => r.id)).toContain(mine);
    await expect(as(db, MANAGER_1, tx => tx.query(`select public.cancel_pledge($1, 'x')`, [mine]))).rejects.toThrow(/Only admins/);
    await expect(as(db, MANAGER_1, tx => tx.query(`update public.pledges set amount = 1 where id = $1`, [mine]))).resolves.toBeTruthy();
    expect((await pledge(db, mine)).amount).toBe('500.00');
    const other = await addPledge(db, { campaign_id: '1002' });
    await expect(as(db, MANAGER_1, tx => tx.query(`select public.add_pledge_note($1, 'x')`, [other]))).rejects.toThrow(/access/);
  });

  it("can't be entered on a closed campaign", async () => {
    await as(db, ADMIN, tx => tx.query(`update public.campaigns set status = 'closed' where id = '1003'`));
    await expect(addPledge(db)).rejects.toThrow(/closed/);
  });
});

describe('recurring pledges', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); });

  it('generate the schedule and the total commitment', async () => {
    const id = await addRecurring(db);
    const s = await schedule(db, id);
    expect(s.length).toBe(12);
    expect(s.slice(0, 3).map(i => i.due_date.toISOString().slice(0, 10))).toEqual(['2030-01-31', '2030-02-28', '2030-03-31']);
    expect(await pledge(db, id)).toMatchObject({ amount: '6000.00', balance: '6000.00', status: 'open', next_due_amount: '500.00', installments_upcoming: 12 });
  });

  it('space weekly, quarterly and annual schedules', async () => {
    const dates = async (frequency: string) =>
      (await schedule(db, await addRecurring(db, { frequency, installment_count: 2 })))[1].due_date.toISOString().slice(0, 10);
    expect(await dates('weekly')).toBe('2030-02-07');
    expect(await dates('quarterly')).toBe('2030-04-30');
    expect(await dates('annually')).toBe('2031-01-31');
  });

  it('match a payment to the next installment', async () => {
    const id = await addRecurring(db);
    await pay(db, { amount: 500 });
    const s = await schedule(db, id);
    expect(s[0].status).toBe('fulfilled');
    expect(s[1].status).toBe('open');
    expect(await pledge(db, id)).toMatchObject({ status: 'partial', received: '500.00', balance: '5500.00', installments_paid: 1 });
    expect((await pledge(db, id)).next_due_date.toISOString().slice(0, 10)).toBe('2030-02-28');
  });

  it('carry a partial payment on the installment, and spread a bigger one forward', async () => {
    const id = await addRecurring(db);
    await pay(db, { amount: 200 });
    expect(await schedule(db, id).then(s => [s[0].status, s[0].remaining])).toEqual(['partial', '300.00']);
    await pay(db, { amount: 1000 });
    const s = await schedule(db, id);
    expect(s.slice(0, 3).map(i => i.remaining)).toEqual(['0.00', '0.00', '300.00']);
  });

  it('can match by hand to a chosen installment', async () => {
    const id = await addRecurring(db, { donor_id: null });
    const s = await schedule(db, id);
    const d = await pay(db, { amount: 500, donor_id: null });
    await as(db, ADMIN, tx => tx.query(`select public.match_pledge_payment($1, $2, $3)`, [id, d, s[4].id]));
    const after = await schedule(db, id);
    expect(after[0].status).toBe('open');
    expect(after[4].status).toBe('fulfilled');
  });

  it('flag overdue installments even with payments made', async () => {
    const id = await addRecurring(db, { start_date: '2020-01-01', installment_count: 3 });
    await pay(db, { amount: 500 });
    const p = await pledge(db, id);
    expect(p).toMatchObject({ status: 'overdue', installments_overdue: 2 });
    expect((await schedule(db, id))[1].status).toBe('overdue');
  });

  it('skip with a note, by a fundraiser too, lowering the commitment', async () => {
    const id = await addRecurring(db);
    const s = await schedule(db, id);
    await expect(as(db, MANAGER_1, tx => tx.query(`select public.skip_installment($1, '')`, [s[0].id]))).rejects.toThrow(/note/);
    await as(db, MANAGER_1, tx => tx.query(`select public.skip_installment($1, 'Donor asked for a pause')`, [s[0].id]));
    expect((await schedule(db, id))[0]).toMatchObject({ status: 'skipped', skip_note: 'Donor asked for a pause' });
    expect((await pledge(db, id)).amount).toBe('5500.00');
    await pay(db, { amount: 500 });
    expect((await schedule(db, id))[1].status).toBe('fulfilled');
    await expect(as(db, ADMIN, tx => tx.query(`select public.skip_installment($1, 'x')`, [s[1].id]))).rejects.toThrow(/already has a payment/);
  });

  it('let admins edit one installment or reschedule, keeping what was paid', async () => {
    const id = await addRecurring(db, { installment_count: 3 });
    await pay(db, { amount: 500 });
    const s = await schedule(db, id);
    await expect(as(db, MANAGER_1, tx => tx.query(`select public.edit_installment($1, null, 600)`, [s[1].id]))).rejects.toThrow(/Only admins/);
    await as(db, ADMIN, tx => tx.query(`select public.edit_installment($1, '2030-03-15', 600)`, [s[1].id]));
    expect((await pledge(db, id)).amount).toBe('1600.00');
    await expect(as(db, ADMIN, tx => tx.query(`select public.edit_installment($1, null, 100)`, [s[0].id]))).rejects.toThrow(/already paid/);

    await as(db, ADMIN, tx => tx.query(`select public.reschedule_pledge($1, 250, 'weekly', '2031-01-01', 4)`, [id]));
    const after = await schedule(db, id);
    expect(after.filter(i => i.status === 'fulfilled').length).toBe(1);
    expect(after.filter(i => i.status === 'cancelled').length).toBe(2);
    expect(after.filter(i => i.status === 'open').map(i => i.amount)).toEqual(['250.00', '250.00', '250.00', '250.00']);
    expect(await pledge(db, id)).toMatchObject({ amount: '1500.00', received: '500.00', balance: '1000.00', frequency: 'weekly' });
  });

  it('cancel what remains and keep what was paid', async () => {
    const id = await addRecurring(db, { installment_count: 3 });
    await pay(db, { amount: 500 });
    await as(db, ADMIN, tx => tx.query(`select public.cancel_pledge($1, 'Moved away')`, [id]));
    const s = await schedule(db, id);
    expect(s.map(i => i.status)).toEqual(['fulfilled', 'cancelled', 'cancelled']);
    expect(await pledge(db, id)).toMatchObject({ status: 'cancelled', received: '500.00' });
    expect((await summary(db, '1003')).pledged_open).toBe('0');
  });

  it('show scheduled income for the next 30 and 90 days', async () => {
    const today = new Date().toISOString().slice(0, 10);
    await addRecurring(db, { start_date: today, installment_count: 12, installment_amount: 100 });
    const s = await summary(db, '1003');
    expect(Number(s.pledge_scheduled_30)).toBeGreaterThanOrEqual(100);
    expect(Number(s.pledge_scheduled_30)).toBeLessThanOrEqual(200);
    expect(Number(s.pledge_scheduled_90)).toBeGreaterThanOrEqual(300);
    expect(Number(s.pledge_scheduled_90)).toBeLessThanOrEqual(400);
  });

  it('keep a rolling year when open-ended', async () => {
    const id = await addRecurring(db, { start_date: '2020-01-01', installment_count: null });
    expect((await schedule(db, id)).length).toBe(12);
    await db.exec(`select public.run_job('pledge_schedules')`);
    const s = await schedule(db, id);
    const today = new Date().toISOString().slice(0, 10);
    expect(s.filter(i => i.due_date.toISOString().slice(0, 10) > today).length).toBe(12);
    expect(s.map(i => i.seq)).toEqual(s.map((_, n) => n + 1));
    expect((await pledge(db, id)).amount).toBe((s.length * 500).toFixed(2));
    const again = s.length;
    await db.exec(`select public.run_job('pledge_schedules')`);
    expect((await schedule(db, id)).length).toBe(again);
  });

  it('keep schedules behind the functions', async () => {
    const id = await addRecurring(db);
    const s = await schedule(db, id);
    await expect(as(db, ADMIN, tx => tx.query(`update public.pledge_installments set amount = 1 where id = $1`, [s[0].id]))).rejects.toThrow();
    await expect(as(db, ADMIN, tx => tx.query(`insert into public.pledge_payments (org_id, pledge_id, donation_id, amount, matched_by) select org_id, id, 'p1', 1, 'manual' from public.pledges where id = $1`, [id]))).rejects.toThrow();
  });
});
