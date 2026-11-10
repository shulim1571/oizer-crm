import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, MANAGER_1, OIZER, as, rows, seededDb } from './harness';

const sql = (db: PGlite, q: string, params: unknown[] = [], user = ADMIN) => as(db, user, tx => tx.query(q, params));
const one = async <T = Record<string, any>>(db: PGlite, q: string, params: unknown[] = [], user: string = ADMIN) => (await rows<T>(db, user, q, params))[0];
const svc = async (db: PGlite, q: string, params: unknown[] = []) => (await rows(db, 'service_role', q, params))[0];
const page = async (db: PGlite, campaign = '1001') => (await one(db, `select public.public_give_page($1, $2) p`, [OIZER, campaign], 'anon')).p;
const DONOR = { first_name: 'Chaim', last_name: 'Gold', phone: '(718) 555-0199', email: 'chaim@example.org', notes: 'In honor of Bubby' };
const give = (db: PGlite, amount: number, extra: { cover?: boolean; donor?: object; custom?: object; ip?: string; campaign?: string } = {}) =>
  svc(db, `select public.begin_public_sale($1, $2, $3, $4, $5, $6, $7) r`,
    [OIZER, extra.campaign ?? '1001', amount, extra.cover ?? false, JSON.stringify(extra.donor ?? DONOR), JSON.stringify(extra.custom ?? {}), extra.ip ?? '9.9.9.9']).then(x => x.r);
const answer = async (db: PGlite, id: string, result: object) => {
  await svc(db, `select * from public.claim_gateway_request($1, $2)`, [OIZER, id]);
  return (await svc(db, `select public.record_gateway_result($1, $2, $3) r`, [OIZER, id, JSON.stringify(result)])).r;
};
const OK = { xResult: 'A', xRefNum: '2000001', xMaskedCardNumber: '4xxxxxxxxxxx1111', xCardType: 'Visa' };

describe('public payment pages', () => {
  let base: PGlite;
  let db: PGlite;
  beforeAll(async () => {
    base = await seededDb();
    await base.query(`update public.org_members set role = 'super_admin' where user_id = $1`, [ADMIN]);
    await base.query(`update public.organizations set check_payee = 'Cong. Oizer', zelle = 'give@oizer.org', ein = '99-0000000' where id = $1`, [OIZER]);
    await as(base, ADMIN, tx => tx.query(`select public.save_payment_settings('ifields_public', 'api_secret', null, true)`));
    await base.query(`update public.campaigns set goal = 10000, external_name = 'Building Fund' where id = '1001'`);
    await as(base, ADMIN, tx => tx.query(`select public.save_campaign_settings('1001', $1)`, [JSON.stringify({
      language: 'he', preset_amounts: [180, 360, 500], allow_other_amount: true, min_donation: 18, donor_wall: true,
      custom_fields: [{ name: 'In honor of', type: 'text', required: false }, { name: 'Table number', type: 'number', required: true }],
    })]));
  });
  beforeEach(async () => { db = await base.clone(); });

  it('show the page to anyone, without anything private', async () => {
    const p = await page(db);
    expect(p.campaign).toMatchObject({ id: '1001', name: 'Building Fund', goal: 10000 });
    expect(Number(p.campaign.raised)).toBeGreaterThan(0);
    expect(p.org).toMatchObject({ name: 'Oizer Umoshia', check_payee: 'Cong. Oizer', zelle: 'give@oizer.org', ein: '99-0000000' });
    expect(p.page).toMatchObject({ language: 'he', presets: [180, 360, 500], min: 18, cover_fee: true, confirm_over: 5000 });
    expect(p.payments).toEqual({ ready: true, ifields_key: 'ifields_public', sandbox: true, ach: false, daf: [], ach_authorization: null, turnstile_site_key: null });
    expect(JSON.stringify(p)).not.toContain('api_secret');
    expect(p.page.donor_wall[0]).toHaveProperty('amount');
    await db.query(`update public.campaigns set status = 'closed' where id = '1002'`);
    expect(await page(db, '1002')).toBeNull();
    expect(await page(db, 'nope')).toBeNull();
  });

  it('give every campaign a link to its page', async () => {
    expect((await one(db, `select payment_link from public.campaigns where id = '1001'`)).payment_link).toBe('https://oizer.trubase.org/#/give/1001');
    const c = await one(db, `insert into public.campaigns (id, internal_name, manager_id, sub_manager_ids) values ('2001', 'New one', 'm1', '{}') returning payment_link`);
    expect(c.payment_link).toBe('https://oizer.trubase.org/#/give/2001');
  });

  it('work out cover-the-fee so the campaign gets the full gift', async () => {
    await db.query(`update public.payment_methods set fee_type = 'percent_flat', fee_percent = 2.9, fee_flat = 0.30 where name = 'Credit Card'`);
    const total = Number((await one(db, `select public.public_cover_fee($1, '1001', 100) t`, [OIZER], 'anon')).t);
    expect(total).toBeCloseTo(103.3, 1);
    const r = await give(db, 100, { cover: true, custom: { 'Table number': '12' } });
    expect(Number(r.total)).toBe(total);
    const g = await answer(db, r.id, OK);
    const d = await one(db, `select amount, fee, net_donation, fee_covered, custom_fields, source, created_by from public.donations where id = $1`, [g.donation_id]);
    expect(Number(d.amount) - Number(d.fee)).toBeGreaterThanOrEqual(100);
    expect(Number(d.amount) - Number(d.fee)).toBeLessThan(100.02);
    expect(d).toMatchObject({ fee_covered: true, custom_fields: { 'Table number': '12' }, source: 'Online', created_by: 'Online payment page' });
  });

  it('add the donor on success, or find them by phone or email', async () => {
    const a = await answer(db, (await give(db, 50, { custom: { 'Table number': '3' } })).id, OK);
    const donor = await one(db, `select first_name, last_name, phone, email from public.donors where id = $1`, [a.donor_id]);
    expect(donor).toEqual({ first_name: 'Chaim', last_name: 'Gold', phone: '(718) 555-0199', email: 'chaim@example.org' });
    const b = await answer(db, (await give(db, 50, { donor: { ...DONOR, phone: '718-555-0199', email: '' }, custom: { 'Table number': '3' } })).id, { ...OK, xRefNum: '2000002' });
    expect(b.donor_id).toBe(a.donor_id);
    const declined = await answer(db, (await give(db, 20, { donor: { ...DONOR, first_name: 'New', phone: '212-555-0000', email: 'new@example.org' }, custom: { 'Table number': '3' } })).id,
      { xResult: 'D', xError: 'Declined', xRefNum: '2000003' });
    expect(declined.donor_id).toBeNull();
    expect((await one(db, `select status, notes from public.donations where id = $1`, [declined.donation_id])))
      .toEqual({ status: 'failed', notes: 'In honor of Bubby · Declined: Declined · IP 9.9.9.9' });
  });

  it('hold the page to its own rules', async () => {
    await expect(give(db, 10, { custom: { 'Table number': '1' } })).rejects.toThrow(/smallest gift here is \$18/);
    await expect(give(db, 100)).rejects.toThrow(/Table number is required/);
    await expect(give(db, 100, { donor: { ...DONOR, last_name: '' }, custom: { 'Table number': '1' } })).rejects.toThrow(/first and last name/);
    await expect(give(db, 100, { donor: { ...DONOR, phone: '' }, custom: { 'Table number': '1' } })).rejects.toThrow(/phone number/);
    await sql(db, `select public.save_campaign_settings('1001', $1)`, [JSON.stringify({ preset_amounts: [180], allow_other_amount: false })]);
    await expect(give(db, 100)).rejects.toThrow(/Choose one of the amounts/);
    expect((await give(db, 180)).total).toBe(180);
    await sql(db, `select public.save_page_content('1001', false, true, null, null, null, null)`);
    expect(await page(db)).toBeNull();
    await expect(give(db, 180)).rejects.toThrow(/isn't taking donations/);
  });

  it('slow down a connection that keeps failing', async () => {
    for (let i = 0; i < 5; i++) {
      await answer(db, (await give(db, 20, { custom: { 'Table number': '1' }, ip: '6.6.6.6' })).id, { xResult: 'D', xError: 'Declined', xRefNum: `30000${i}` });
    }
    await expect(give(db, 20, { custom: { 'Table number': '1' }, ip: '6.6.6.6' })).rejects.toThrow(/Too many attempts/);
    expect((await give(db, 20, { custom: { 'Table number': '1' }, ip: '7.7.7.7' })).id).toBeTruthy();
  });

  it('put a receipt request on the Task Sheet, only for a real approved gift', async () => {
    const r = await give(db, 50, { custom: { 'Table number': '3' } });
    await expect(rows(db, 'anon', `select public.request_receipt($1, 'chaim@example.org', null)`, [r.token])).rejects.toThrow(/expired/);
    await answer(db, r.id, OK);
    await rows(db, 'anon', `select public.request_receipt($1, 'Chaim@Example.org', null)`, [r.token]);
    const [t] = await rows(db, ADMIN, `select task_type, summary, amount from public.admin_task_sheet where task_type = 'receipt_requested'`);
    expect(t).toEqual({ task_type: 'receipt_requested', summary: 'Chaim Gold asked for a receipt by email (chaim@example.org)', amount: '50.00' });
    const key = (await one(db, `select task_key from public.task_items`)).task_key;
    await sql(db, `select public.resolve_task_item($1)`, [key]);
    expect(await rows(db, ADMIN, `select 1 from public.admin_task_sheet where task_type = 'receipt_requested'`)).toEqual([]);
    expect(await rows(db, MANAGER_1, `select * from public.task_items`)).toEqual([]);
  });

  it('take a receipt request off the Task Sheet once the receipt is sent, from wherever it is sent', async () => {
    const asked = async (amount: number) => {
      const r = await give(db, amount, { custom: { 'Table number': '4' } });
      await answer(db, r.id, OK);
      await rows(db, 'anon', `select public.request_receipt($1, 'chaim@example.org', null)`, [r.token]);
      return (await one(db, `select donation_id from public.gateway_transactions where id = $1`, [r.id])).donation_id as string;
    };
    const open = async () => (await rows(db, ADMIN, `select record_id from public.admin_task_sheet where task_type = 'receipt_requested' order by record_id`)).map(r => r.record_id);
    const first = await asked(50);
    const second = await asked(75);
    expect((await open()).sort()).toEqual([first, second].sort());

    // Issuing alone doesn't close it: the donor hasn't got it yet.
    const receipt = (await one(db, `select public.issue_receipt($1) id`, [first])).id;
    expect((await open()).sort()).toEqual([first, second].sort());

    // Sending it does, whichever screen it was sent from; the other request stays.
    await one(db, `select public.send_document('receipt', $1, null, 'R-1', '<p>Receipt</p>', 'chaim@example.org', null, 'https://oizer.trubase.org/')`, [receipt]);
    expect(await open()).toEqual([second]);
    expect((await one(db, `select resolved_at is not null done from public.task_items where task_key = $1`, [`receipt_requested:${first}`])).done).toBe(true);
  });

  it('let the primary fundraiser edit the page, and nobody else', async () => {
    await sql(db, `select public.save_page_content('1001', true, false, 360, 'Help us build', 'Thank you!', 'https://example.org/b.png')`, [], MANAGER_1);
    const p = await page(db);
    expect(p.page).toMatchObject({ cover_fee: false, suggested: 360, description: 'Help us build', thank_you: 'Thank you!', banner_url: 'https://example.org/b.png' });
    await expect(sql(db, `select public.save_page_content('1002', true, true, null, null, null, null)`, [], MANAGER_1)).rejects.toThrow(/Only an admin or the campaign's primary/);
    await expect(sql(db, `select public.save_page_content('1001', true, true, null, null, null, 'http://x.org/a.png')`)).rejects.toThrow(/https/);
  });
});
