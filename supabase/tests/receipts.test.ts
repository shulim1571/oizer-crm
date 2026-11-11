import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, MANAGER_1, MANAGER_2, as, rows, seededDb } from './harness';

const sql = (db: PGlite, q: string, params: unknown[] = [], user = ADMIN) => as(db, user, tx => tx.query(q, params));
const one = async <T = Record<string, any>>(db: PGlite, q: string, params: unknown[] = [], user = ADMIN) => (await rows<T>(db, user, q, params))[0];
const give = async (db: PGlite, campaign = '1001', amount = 180, method: string | null = 'Check', donor: string | null = 'd1') =>
  (await one<{ id: string }>(db, `insert into public.donations (campaign_id, donor_id, amount, type, status, payment_method) values ($1, $2, $3, 'Payment', 'completed', $4) returning id`,
    [campaign, donor, amount, method])).id;
const receipt = async (db: PGlite, donation: string, extra = '') =>
  (await one<{ id: string }>(db, `select public.issue_receipt($1${extra}) as id`, [donation])).id;
const get = (db: PGlite, id: string) => one(db, `select * from public.receipts where id = $1`, [id]);
const template = (db: PGlite, level: string, ref: string, he: string | null, en: string | null, user = ADMIN) =>
  sql(db, `select public.save_receipt_template($1, $2, null, $3, $4)`, [level, ref, he, en], user);

describe('receipts', () => {
  let db: PGlite;
  beforeEach(async () => {
    db = await seededDb();
    await sql(db, `update public.donors set english_title = 'Mr.', first_name = 'Moshe', last_name = 'Klein', address = '12 Elm St, Monsey NY 10952',
                   yiddish_title = 'ר׳', yiddish_first_name = 'משה', yiddish_last_name = 'קליין' where id = 'd1'`);
  });

  it('get permanent numbers in order, with the donor and campaign as they were', async () => {
    const a = await receipt(db, await give(db));
    const b = await receipt(db, await give(db, '1002', 50));
    const year = new Date().getFullYear();
    const ra = await get(db, a);
    expect(ra).toMatchObject({ receipt_number: `R-${year}-00001`, donor_name: 'Moshe Klein', donor_title: 'Mr.', donor_address: '12 Elm St, Monsey NY 10952',
      hebrew_name: 'ר׳ משה קליין', amount: '180.00', actual_amount: '180.00', status: 'issued' });
    expect((await get(db, b)).receipt_number).toBe(`R-${year}-00002`);
    await sql(db, `update public.donors set first_name = 'Changed' where id = 'd1'`);
    await sql(db, `update public.campaigns set external_name = 'Renamed' where id = '1001'`);
    expect(await get(db, a)).toMatchObject({ donor_name: 'Moshe Klein' });
  });

  it('are refused for DAF money, vouchers, unfinished and repeat donations', async () => {
    await expect(receipt(db, await give(db, '1001', 50, 'OJC'))).rejects.toThrow(/DAF/);
    const pending = (await one<{ id: string }>(db, `insert into public.donations (campaign_id, donor_id, amount, type, status) values ('1001', 'd1', 5, 'Payment', 'pending') returning id`)).id;
    await expect(receipt(db, pending)).rejects.toThrow(/completed/);
    await expect(receipt(db, await give(db, '1001', 5, 'Cash', null))).rejects.toThrow(/donor/);
    const d = await give(db);
    const r = await receipt(db, d);
    await expect(receipt(db, d)).rejects.toThrow(new RegExp(`already has receipt ${(await get(db, r)).receipt_number}`));
  });

  it('take the receipt text from the nearest level that has it', async () => {
    await template(db, 'default', '', 'ברכה כללית', 'Thank you for your gift of {amount}.');
    await template(db, 'fundraiser', 'm1', 'ברכת המגבית', null);
    const r1 = await get(db, await receipt(db, await give(db, '1001')));
    expect(r1).toMatchObject({ hebrew_text: 'ברכת המגבית', english_text: 'Thank you for your gift of {amount}.' });
    // No campaign has its own text any more (Moshe Henig, 2026-11-11): the standard text applies.
    const r2 = await get(db, await receipt(db, await give(db, '1002')));
    expect(r2).toMatchObject({ hebrew_text: 'ברכה כללית', english_text: 'Thank you for your gift of {amount}.' });
    const r3 = await get(db, await receipt(db, await give(db, '1002'), `, null, null, null, null, 'לכבוד המיוחד', 'One time only'`));
    expect(r3).toMatchObject({ hebrew_text: 'לכבוד המיוחד', english_text: 'One time only' });
  });

  it('no longer have campaign-level text: campaigns use the standard receipt text', async () => {
    await expect(template(db, 'campaign', '1001', null, 'From the fundraiser', MANAGER_1)).rejects.toThrow(/no longer have their own receipt text/);
    await expect(template(db, 'campaign', '1001', null, 'x')).rejects.toThrow(/no longer have their own receipt text/);
    await expect(db.query(`insert into public.receipt_templates (org_id, level, ref_id, english_text) select org_id, 'campaign', '1001', 'x' from public.campaigns limit 1`)).rejects.toThrow(/receipt_templates_level_check/);
    await expect(template(db, 'default', '', null, 'x', MANAGER_1)).rejects.toThrow();
    expect(await rows(db, ADMIN, `select * from public.receipt_templates where level = 'campaign'`)).toEqual([]);
  });

  it('can show part of a donation, while the donation stays whole', async () => {
    const d = await give(db, '1001', 1000);
    const r = await get(db, await receipt(db, d, `, 500, null, 'Donor asked for part'`));
    expect(r).toMatchObject({ amount: '500.00', actual_amount: '1000.00', amount_reason: 'Donor asked for part' });
    expect((await one(db, `select amount from public.donations where id = $1`, [d])).amount).toBe('1000.00');
  });

  it('void and correct: the old number stays voided, the new one points back', async () => {
    const d = await give(db);
    const old = await receipt(db, d);
    const fixed = (await one<{ id: string }>(db, `select public.correct_receipt($1, 150, '2026-12-31', 'Moshe & Rivka Klein', null, null, 'Wrong amount') as id`, [old])).id;
    expect(await get(db, old)).toMatchObject({ status: 'voided', void_reason: 'Wrong amount' });
    const n = await get(db, fixed);
    expect(n).toMatchObject({ status: 'issued', corrects_id: old, amount: '150.00', donor_name: 'Moshe & Rivka Klein' });
    expect((await one(db, `select receipt_date::text as d from public.receipts where id = $1`, [fixed])).d).toBe('2026-12-31');
    expect(n.receipt_number).not.toBe((await get(db, old)).receipt_number);
    await expect(sql(db, `select public.void_receipt($1, '')`, [fixed])).rejects.toThrow(/reason/);
    await sql(db, `select public.void_receipt($1, 'Issued in error')`, [fixed]);
    await expect(sql(db, `select public.void_receipt($1, 'again')`, [fixed])).rejects.toThrow(/already voided/);
  });

  it('are voided when the donation changes, and the Task Sheet asks for a new one', async () => {
    const d = await give(db);
    const r = await receipt(db, d);
    await sql(db, `update public.donations set amount = 200 where id = $1`, [d]);
    expect(await get(db, r)).toMatchObject({ status: 'voided', void_reason: 'The donation was changed', needs_reissue: true });
    expect((await one(db, `select task_type from public.admin_task_sheet where record_id = $1`, [r])).task_type).toBe('receipt_reissue');
    const again = await receipt(db, d);
    expect(Number((await get(db, again)).amount)).toBe(200);
    expect(await rows(db, ADMIN, `select 1 from public.admin_task_sheet where record_id = $1`, [r])).toEqual([]);
    await sql(db, `update public.donations set status = 'refunded' where id = $1`, [d]);
    expect((await get(db, again)).needs_reissue).toBe(false);
  });

  it('cover every part of a split donation on one receipt', async () => {
    const a = await give(db, '1001', 60);
    const b = await give(db, '1002', 40);
    await sql(db, `update public.donations set split_group_id = 'sg1' where id in ($1, $2)`, [a, b]);
    const r = await get(db, await receipt(db, b));
    expect(r.actual_amount).toBe('100.00');
    expect(r.donation_ids.sort()).toEqual([a, b].sort());
    expect(r.items.map((i: any) => i.amount).sort()).toEqual([40, 60]);
    await expect(receipt(db, a)).rejects.toThrow(/already has receipt/);
  });

  it('list what can still be receipted in a range', async () => {
    const a = await give(db);
    const b = await give(db, '1001', 5, 'OJC');
    await receipt(db, await give(db));
    const today = (await one<{ d: string }>(db, `select public.org_today()::text as d`)).d;
    const list = await rows<{ donation_id: string }>(db, ADMIN, `select * from public.receipt_candidates($1, $1)`, [today]);
    expect(list.map(r => r.donation_id)).toContain(a);
    expect(list.map(r => r.donation_id)).not.toContain(b);
    expect(await rows(db, MANAGER_1, `select * from public.receipt_candidates($1, $1)`, [today])).toEqual([]);
  });

  it('are issued by admins, and fundraisers see them on their own campaigns only', async () => {
    const d = await give(db);
    await expect(rows(db, MANAGER_1, `select public.issue_receipt($1)`, [d])).rejects.toThrow();
    await receipt(db, d);
    expect((await rows(db, MANAGER_1, `select receipt_number from public.receipts`)).length).toBe(1);
    expect(await rows(db, MANAGER_2, `select receipt_number from public.receipts`)).toEqual([]);
    await expect(sql(db, `update public.receipts set amount = 1`)).rejects.toThrow();
  });

  it('remind the office to set up receipt text', async () => {
    expect((await rows(db, ADMIN, `select 1 from public.admin_task_sheet where task_type = 'receipt_text_missing'`)).length).toBe(1);
    await template(db, 'default', '', null, 'Thank you');
    expect(await rows(db, ADMIN, `select 1 from public.admin_task_sheet where task_type = 'receipt_text_missing'`)).toEqual([]);
  });
});

describe('tax statements', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); });

  it('list a donor\'s year with corrected amounts and leave out DAF money', async () => {
    const a = await give(db, '1001', 100);
    await give(db, '1002', 50);
    await give(db, '1001', 70, 'OJC');
    const r = await receipt(db, a);
    await sql(db, `select public.correct_receipt($1, 80, null)`, [r]);
    const year = new Date().getFullYear();
    const items = await rows<{ amount: string; campaign_id: string }>(db, ADMIN, `select * from public.statement_items('d1', $1)`, [year]);
    expect(items.map(i => [i.campaign_id, i.amount]).filter(([c]) => c !== '1001' || true)).toContainEqual(['1001', '80.00']);
    expect(items.map(i => i.amount)).not.toContain('70.00');
    const only1002 = await rows(db, ADMIN, `select * from public.statement_items('d1', $1, array['1002'])`, [year]);
    expect(only1002.map((i: any) => i.campaign_id)).toEqual(['1002']);
    const byFundraiser = await rows(db, ADMIN, `select * from public.statement_items('d1', $1, null, 'm2')`, [year]);
    expect(byFundraiser.every((i: any) => ['1002', '1003'].includes(i.campaign_id))).toBe(true);
  });

  it('are logged for good, with repeats marked revised', async () => {
    await give(db, '1001', 100);
    const year = new Date().getFullYear();
    await sql(db, `select public.log_tax_statement('d1', $1)`, [year]);
    await sql(db, `select public.log_tax_statement('d1', $1)`, [year]);
    await sql(db, `select public.log_tax_statement('d1', $1, array['1002'])`, [year]);
    const log = await rows<{ revised: boolean; scope: string }>(db, ADMIN, `select revised, scope from public.tax_statements order by generated_at`);
    expect(log).toEqual([{ revised: false, scope: 'all' }, { revised: true, scope: 'all' }, { revised: false, scope: 'campaigns' }]);
    await expect(sql(db, `delete from public.tax_statements`)).rejects.toThrow();
    await expect(rows(db, MANAGER_1, `select public.log_tax_statement('d1', $1)`, [year])).rejects.toThrow();
  });
});
