import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, MANAGER_1, OIZER, as, rows, seededDb } from './harness';

const sql = (db: PGlite, q: string, params: unknown[] = [], user = ADMIN) => as(db, user, tx => tx.query(q, params));
const one = async <T = Record<string, any>>(db: PGlite, q: string, params: unknown[] = [], user: string = ADMIN) => (await rows<T>(db, user, q, params))[0];
const svc = async (db: PGlite, q: string, params: unknown[] = []) => rows(db, 'service_role', q, params);
const DONOR = { first_name: 'Chaim', last_name: 'Gold', phone: '718-555-0199', email: 'chaim@example.org' };
const OK = (ref: string) => ({ xResult: 'A', xRefNum: ref, xMaskedCardNumber: '4xxxxxxxxxxx1111', xCardType: 'Visa', xExp: '1230', xToken: 'tok_rec' });
const pageGift = async (db: PGlite, amount: number, recurring: object) => {
  const r = (await svc(db, `select public.begin_public_sale($1, '1001', $2, false, $3, '{}', '9.9.9.9', $4) r`,
    [OIZER, amount, JSON.stringify(DONOR), JSON.stringify(recurring)]))[0].r;
  await svc(db, `select * from public.claim_gateway_request($1, $2)`, [OIZER, r.id]);
  return r;
};
const record = async (db: PGlite, id: string, result: object) =>
  (await svc(db, `select public.record_gateway_result($1, $2, $3) r`, [OIZER, id, JSON.stringify(result)]))[0].r;
const today = async (db: PGlite) => (await db.query<{ d: string }>(`select ((now() at time zone 'America/New_York')::date)::text d`)).rows[0].d;
const rec = (db: PGlite) => one(db, `select * from public.recurring_donations order by created_at desc limit 1`);
const claim = async (db: PGlite) => svc(db, `select * from public.claim_recurring_charges(25)`);

describe('recurring donations', () => {
  let base: PGlite;
  let db: PGlite;
  beforeAll(async () => {
    base = await seededDb();
    await base.query(`update public.org_members set role = 'super_admin' where user_id = $1`, [ADMIN]);
    await base.query(`insert into public.messaging_settings (org_id, live) values ($1, true)`, [OIZER]);
    await as(base, ADMIN, tx => tx.query(`select public.save_payment_settings('ifields_public', 'api_secret', null, true)`));
  });
  beforeEach(async () => { db = await base.clone(); });

  it('start from the page: the first payment now, the card saved, the donor told', async () => {
    const g = await pageGift(db, 180, { frequency: 'monthly', count: 12 });
    expect(g.kind).toBe('sale');
    await record(db, g.id, OK('R1'));
    const r = await rec(db);
    const d = await today(db);
    expect(r).toMatchObject({ amount: '180.00', frequency: 'monthly', total_payments: 12, payments_made: 1, status: 'active', source: 'page', notify_email: 'chaim@example.org' });
    expect(r.start_date.toISOString().slice(0, 10)).toBe(d);
    expect(r.card_id).toBeTruthy();
    const m = (await db.query<{ subject: string; body: string }>(`select subject, body from public.messages where kind = 'recurring'`)).rows;
    expect(m[0].subject).toBe('Recurring donation confirmed');
    expect(m[0].body).toContain('$180.00 each month, 12 payments in all ($2,160.00).');
    expect(await claim(db)).toEqual([]);
  });

  it('start later from the page: save the card now, charge on the start date', async () => {
    const start = (await db.query<{ d: string }>(`select ((now() at time zone 'America/New_York')::date + 10)::text d`)).rows[0].d;
    const g = await pageGift(db, 50, { frequency: 'weekly', start });
    expect(g.kind).toBe('save');
    await record(db, g.id, { xResult: 'A', xRefNum: 'S1', xToken: 'tok_later', xMaskedCardNumber: '4xxxxxxxxxxx1111', xCardType: 'Visa' });
    const r = await rec(db);
    expect(r).toMatchObject({ payments_made: 0, status: 'active', total_payments: null });
    expect(r.next_charge.toISOString().slice(0, 10)).toBe(start);
    expect((await db.query(`select 1 from public.donations where gateway_id = 'S1'`)).rows).toEqual([]);
    await expect(svc(db, `select public.begin_public_sale($1, '1001', 50, false, $2, '{}', '1.1.1.1', '{"frequency":"weekly","start":"2000-01-01"}')`,
      [OIZER, JSON.stringify(DONOR)])).rejects.toThrow(/start date within the next year/);
  });

  it('charge what is due once, move the schedule on, and finish a fixed count', async () => {
    const g = await pageGift(db, 36, { frequency: 'monthly', count: 2 });
    await record(db, g.id, OK('R1'));
    await db.query(`update public.recurring_donations set next_charge = current_date - 1`);
    const [c] = await claim(db);
    expect(c).toMatchObject({ amount: '36.00', card_token: 'tok_rec', campaign_label: 'First campaign (1001)', card_name: 'Chaim Gold' });
    expect(await claim(db)).toEqual([]);
    const done = await record(db, c.id, OK('R2'));
    const d = await one(db, `select status, notes, source from public.donations where id = $1`, [done.donation_id]);
    expect(d).toMatchObject({ status: 'completed', notes: 'Recurring payment 2 · Visa 1111' });
    expect(await rec(db)).toMatchObject({ payments_made: 2, status: 'completed', next_charge: null });
  });

  it('retry after 3 days and 7 days, then pause and put it on the Task Sheet', async () => {
    const g = await pageGift(db, 25, { frequency: 'monthly' });
    await record(db, g.id, OK('R1'));
    for (const [i, wait] of [[1, 3], [2, 7]] as const) {
      await db.query(`update public.recurring_donations set next_charge = current_date - 2, retry_on = case when retry_on is null then null else current_date - 1 end`);
      const [c] = await claim(db);
      await record(db, c.id, { xResult: 'D', xError: 'Insufficient funds', xRefNum: `F${i}` });
      const r = await rec(db);
      expect(r).toMatchObject({ failures: i, status: 'active', payments_made: 1, last_error: 'Insufficient funds' });
      expect(r.retry_on.toISOString().slice(0, 10)).toBe((await db.query<{ d: string }>(`select ((now() at time zone 'America/New_York')::date + ${wait})::text d`)).rows[0].d);
      // Every failure is on the Task Sheet, not only the third.
      const [item] = await rows(db, ADMIN, `select summary from public.admin_task_sheet where task_type = 'recurring_failed'`);
      expect(item.summary).toMatch(new RegExp(`^Chaim Gold: \\$25\\.00 each month to First campaign \\(1001\\) · failed ${i === 1 ? 'once' : 'twice'} \\(Insufficient funds\\) · tried again `));
    }
    await db.query(`update public.recurring_donations set retry_on = current_date - 1`);
    const [c] = await claim(db);
    await record(db, c.id, { xResult: 'D', xError: 'Card expired', xRefNum: 'F3' });
    expect(await rec(db)).toMatchObject({ failures: 3, status: 'paused', pause_reason: 'Three charges failed' });
    const [t] = await rows(db, ADMIN, `select task_type, summary from public.admin_task_sheet where task_type = 'recurring_failed'`);
    expect(t.summary).toBe("Chaim Gold: $25.00 each month to First campaign (1001) · failed 3 times (Card expired) · paused until the card is updated or it's retried");
    expect(await rows(db, ADMIN, `select 1 from public.admin_task_sheet where task_type = 'recurring_failed'`)).toHaveLength(1);
    const notices = (await db.query<{ to_address: string; subject: string }>(`select to_address, subject from public.messages where kind = 'recurring_failed' order by created_at`)).rows;
    expect(notices.map(n => n.subject)).toEqual(expect.arrayContaining(['A recurring charge failed', 'Recurring donation paused after 3 failed charges']));
    expect(notices.some(n => n.to_address === 'one@example.org')).toBe(true);
    // The fundraiser on the campaign hears about every failure (1, 2 and the pause); admins about the first and the pause.
    const to = (addr: string) => notices.filter(n => n.to_address === addr).length;
    expect(to('one@example.org')).toBe(3);
    expect(to('office@example.org')).toBe(2);
    expect(notices.filter(n => n.subject === 'A recurring charge failed again').map(n => n.to_address)).toEqual(['one@example.org']);
    await sql(db, `select public.set_recurring_status($1, 'retry')`, [(await rec(db)).id]);
    expect(await rows(db, ADMIN, `select 1 from public.admin_task_sheet where task_type = 'recurring_failed'`)).toEqual([]);
    expect(await claim(db)).toHaveLength(1);
  });

  it('take a failed charge off the Task Sheet when a later one goes through, and put it back if a retry fails', async () => {
    const g = await pageGift(db, 30, { frequency: 'weekly' });
    await record(db, g.id, OK('S1'));
    const open = async () => rows(db, ADMIN, `select summary from public.admin_task_sheet where task_type = 'recurring_failed'`);
    await db.query(`update public.recurring_donations set next_charge = current_date - 1`);
    let [c] = await claim(db);
    await record(db, c.id, { xResult: 'D', xError: 'Do not honor', xRefNum: 'S2' });
    expect(await open()).toHaveLength(1);
    // The office retries now: off the sheet; the retry fails: back on.
    await sql(db, `select public.set_recurring_status($1, 'retry')`, [(await rec(db)).id]);
    expect(await open()).toEqual([]);
    [c] = await claim(db);
    await record(db, c.id, { xResult: 'D', xError: 'Do not honor', xRefNum: 'S3' });
    expect((await open())[0].summary).toMatch(/failed twice \(Do not honor\)/);
    // The next charge goes through: off the sheet for good.
    await db.query(`update public.recurring_donations set retry_on = current_date - 1`);
    [c] = await claim(db);
    await record(db, c.id, OK('S4'));
    expect(await open()).toEqual([]);
    expect(await rec(db)).toMatchObject({ failures: 0, status: 'active' });
    // A cancelled schedule doesn't leave an item behind either.
    await db.query(`update public.recurring_donations set next_charge = current_date - 1`);
    [c] = await claim(db);
    await record(db, c.id, { xResult: 'D', xError: 'Card expired', xRefNum: 'S5' });
    expect(await open()).toHaveLength(1);
    await sql(db, `select public.set_recurring_status($1, 'cancel', 'Donor asked')`, [(await rec(db)).id]);
    expect(await open()).toEqual([]);
  });

  it('land a charge for a closed campaign as unattributed', async () => {
    const g = await pageGift(db, 40, { frequency: 'weekly' });
    await record(db, g.id, OK('R1'));
    await db.query(`update public.recurring_donations set next_charge = current_date - 1`);
    await db.query(`update public.campaigns set status = 'closed' where id = '1001'`);
    const [c] = await claim(db);
    const done = await record(db, c.id, OK('R2'));
    expect(await one(db, `select campaign_id, status from public.donations where id = $1`, [done.donation_id])).toEqual({ campaign_id: null, status: 'completed' });
  });

  it('let the office set one up on a saved card, change it, and cancel it', async () => {
    const g = await pageGift(db, 18, { frequency: 'monthly' });
    await record(db, g.id, OK('R1'));
    const first = await rec(db);
    const id = (await one(db, `select public.create_recurring($1, '1002', $2, 100, 'monthly', public.org_today(), 3, 'chaim@example.org') id`, [first.donor_id, first.card_id])).id;
    expect(await one(db, `select payments_made, total_payments, status from public.recurring_donations where id = $1`, [id])).toEqual({ payments_made: 0, total_payments: 3, status: 'active' });
    await sql(db, `select public.update_recurring($1, 120, 'quarterly', $2)`, [id, first.card_id]);
    expect(await one(db, `select amount, frequency from public.recurring_donations where id = $1`, [id])).toEqual({ amount: '120.00', frequency: 'quarterly' });
    await sql(db, `select public.set_recurring_status($1, 'cancel', 'Donor asked')`, [id]);
    expect(await one(db, `select status, cancel_reason from public.recurring_donations where id = $1`, [id])).toEqual({ status: 'cancelled', cancel_reason: 'Donor asked' });
    const subjects = (await db.query<{ subject: string }>(`select subject from public.messages where kind = 'recurring' order by created_at`)).rows.map(x => x.subject);
    expect(subjects).toEqual(['Recurring donation confirmed', 'Recurring donation confirmed', 'Recurring donation changed', 'Recurring donation cancelled']);
    await expect(sql(db, `select public.set_recurring_status($1, 'resume')`, [id])).rejects.toThrow(/has ended/);
    await expect(sql(db, `select public.create_recurring($1, '1002', $2, 10, 'monthly', public.org_today())`, [first.donor_id, first.card_id], MANAGER_1)).rejects.toThrow();
  });

  it('end a recurring donation when its card is deleted', async () => {
    const g = await pageGift(db, 18, { frequency: 'monthly' });
    await record(db, g.id, OK('R1'));
    const r = await rec(db);
    await sql(db, `select public.delete_donor_card($1)`, [r.card_id]);
    expect(await rec(db)).toMatchObject({ status: 'cancelled', cancel_reason: 'Its card was deleted' });
  });

  it('project what is due in the next 30 and 90 days, and let the team see their campaign\'s', async () => {
    const g = await pageGift(db, 10, { frequency: 'weekly' });
    await record(db, g.id, OK('R1'));
    const r = await one(db, `select due_30, due_90 from public.recurring_list`);
    expect(Number(r.due_30)).toBeGreaterThanOrEqual(4);
    expect(Number(r.due_90)).toBeGreaterThanOrEqual(12);
    expect(await rows(db, MANAGER_1, `select id from public.recurring_list`)).toHaveLength(1);
    expect((await one(db, `select campaign_label from public.recurring_list`)).campaign_label).toBe('First campaign (1001)');
    expect((await db.query<{ ok: boolean }>(`select has_function_privilege('authenticated', 'public.campaign_label(uuid, text)', 'execute') ok`)).rows[0].ok).toBe(false);
  });
});
