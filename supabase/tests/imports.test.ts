import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, MANAGER_1, MANAGER_2, as, rows, seededDb } from './harness';

const sql = (db: PGlite, q: string, params: unknown[] = [], user = ADMIN) => as(db, user, tx => tx.query(q, params));
const one = async <T = Record<string, any>>(db: PGlite, q: string, params: unknown[] = [], user = ADMIN) => (await rows<T>(db, user, q, params))[0];
const run = async (db: PGlite, kind: string, data: object[], options: object = {}, commit = true, user = ADMIN) =>
  (await one<{ r: any }>(db, `select public.run_import($1, 'test.csv', $2, $3, $4) as r`, [kind, JSON.stringify(data), JSON.stringify(options), commit], user)).r;
const count = async (db: PGlite, table: string, where = 'true') => Number((await one(db, `select count(*) as n from public.${table} where ${where}`)).n);
const balance = async (db: PGlite, id: string) => Number((await one(db, `select balance from public.campaign_summary where id = $1`, [id])).balance);

describe('imports', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); });

  it('preview without changing anything, then commit', async () => {
    const before = await count(db, 'donors');
    const preview = await run(db, 'donors', [{ first_name: 'Chaim', last_name: 'Gold', email: 'chaim@example.com' }, { first_name: 'No last' }], {}, false);
    expect(preview).toMatchObject({ committed: false, created: 1, errors: 1 });
    expect(preview.rows[1]).toMatchObject({ row: 2, status: 'error' });
    expect(await count(db, 'donors')).toBe(before);
    expect(await count(db, 'imports')).toBe(0);
    const done = await run(db, 'donors', [{ first_name: 'Chaim', last_name: 'Gold', email: 'chaim@example.com', city: 'Monsey', state: 'NY', postal_code: '10952', address: '5 Main' }]);
    expect(done).toMatchObject({ committed: true, created: 1 });
    expect((await one(db, `select address from public.donors where email = 'chaim@example.com'`)).address).toBe('5 Main\nMonsey, NY 10952');
    expect((await one(db, `select kind, created, imported_by from public.imports`))).toEqual({ kind: 'donors', created: 1, imported_by: 'office@example.org' });
  });

  it('are for the Super Admin, except contact lists', async () => {
    await expect(run(db, 'donors', [{ first_name: 'A', last_name: 'B' }], {}, true, MANAGER_1)).rejects.toThrow(/Super Admin/);
    await expect(run(db, 'contacts', [{ first_name: 'A' }], { campaign: '1002' }, true, MANAGER_1)).rejects.toThrow(/own campaigns/);
  });

  it('skip, merge or add duplicate donors as chosen', async () => {
    await sql(db, `update public.donors set email = 'one@donor.org', phone = null where id = 'd1'`);
    const row = { first_name: 'Donor', last_name: 'One', email: 'ONE@donor.org', phone: '(845) 555-0000' };
    expect((await run(db, 'donors', [row])).skipped).toBe(1);
    expect((await run(db, 'donors', [row], { duplicates: 'merge' })).updated).toBe(1);
    expect((await one(db, `select phone from public.donors where id = 'd1'`)).phone).toBe('(845) 555-0000');
    expect((await run(db, 'donors', [row], { duplicates: 'new' })).created).toBe(1);
  });

  it('bring in campaigns with their IDs, sub-campaigns and an opening balance', async () => {
    await sql(db, `update public.managers set first_name = 'Manager', last_name = 'One' where id = 'm1'`);
    const r = await run(db, 'campaigns', [
      { campaign_id: '2001', internal_name: 'Kollel', external_name: 'Kollel Fund', fundraiser: 'Manager One', goal: '$10,000', opening_balance: '1,250.50' },
      { parent_id: '2001', internal_name: 'Kollel table 1', external_name: 'Table 1' },
      { campaign_id: '1001', internal_name: 'Dup', external_name: 'Dup' },
      { campaign_id: '2002', internal_name: 'X', external_name: 'X', fundraiser: 'Nobody' },
    ]);
    expect(r).toMatchObject({ created: 2, skipped: 1, errors: 1 });
    expect(await one(db, `select manager_id, goal, status from public.campaigns where id = '2001'`)).toEqual({ manager_id: 'm1', goal: '10000.00', status: 'active' });
    expect(await one(db, `select parent_campaign_id, balance_mode from public.campaigns where id = '2001-A'`)).toEqual({ parent_campaign_id: '2001', balance_mode: 'shared' });
    expect(await balance(db, '2001')).toBeCloseTo(1250.5, 2);
    const ob = await one(db, `select name, donor_id, fee, source from public.donations where campaign_id = '2001'`);
    expect(ob).toEqual({ name: 'Opening Balance (Migrated)', donor_id: null, fee: '0.00', source: 'Imported' });
    const id = (await one(db, `select id from public.donations where campaign_id = '2001'`)).id;
    await expect(sql(db, `select public.issue_receipt($1)`, [id])).rejects.toThrow(/opening balance/);
  });

  it('overwrite a campaign when asked, and put it back on reversal', async () => {
    const r = await run(db, 'campaigns', [{ campaign_id: '1001', internal_name: 'Renamed', external_name: 'Renamed', status: 'Archived' }], { duplicates: 'overwrite' });
    expect(r.updated).toBe(1);
    expect((await one(db, `select internal_name, status from public.campaigns where id = '1001'`))).toEqual({ internal_name: 'Renamed', status: 'archived' });
    const imp = (await one(db, `select id from public.imports`)).id;
    await sql(db, `select public.reverse_import($1)`, [imp]);
    expect((await one(db, `select internal_name, status from public.campaigns where id = '1001'`)).status).toBe('active');
  });

  it('bring in donation history linked by donor and campaign, without fees', async () => {
    const before = await balance(db, '1002');
    const r = await run(db, 'donations', [
      { donor_id: 'd1', campaign_id: '1002', amount: '100', date: '3/15/2025', payment_method: 'Check', receipt_sent: 'Y' },
      { donor_name: 'Brand New Person', campaign_name: 'Second campaign', amount: '50', date: '2025-04-01' },
      { donor_id: 'd1', campaign_id: '9999', amount: '5', date: '2025-01-01' },
      { donor_id: 'd1', campaign_id: '1002', amount: 'abc', date: '2025-01-01' },
    ]);
    expect(r).toMatchObject({ created: 2, errors: 2 });
    expect(r.rows[2].message).toMatch(/No campaign 9999/);
    expect(await balance(db, '1002')).toBeCloseTo(before + 150, 2);
    const d = await one(db, `select fee, source, notes, (created_at at time zone 'America/New_York')::date::text as day from public.donations where donor_id = 'd1' and campaign_id = '1002' and source = 'Imported'`);
    expect(d).toEqual({ fee: '0.00', source: 'Imported', notes: 'Receipt sent before import', day: '2025-03-15' });
    expect(await count(db, 'donors', `display_name = 'Brand New Person'`)).toBe(1);
  });

  it('bring in pledges, open or cancelled', async () => {
    const r = await run(db, 'pledges', [
      { donor_id: 'd2', campaign_id: '1001', pledge_amount: '360', date_pledged: '2026-01-05', expected_date: '2026-12-01' },
      { donor_id: 'd2', campaign_id: '1001', pledge_amount: '100', date_pledged: '2026-01-05', status: 'Cancelled' },
      { donor_id: 'd2', campaign_id: '1001', pledge_amount: '100', date_pledged: '2026-01-05', status: 'Fulfilled' },
    ]);
    expect(r).toMatchObject({ created: 2, skipped: 1 });
    expect(await count(db, 'pledges', `donor_id = 'd2' and cancelled_at is not null`)).toBe(1);
  });

  it('add fundraisers, skipping ones already here', async () => {
    const r = await run(db, 'fundraisers', [
      { first_name: 'New', last_name: 'Fundraiser', email: 'new@example.org' },
      { first_name: 'Again', last_name: 'One', email: 'ONE@example.org' },
    ]);
    expect(r).toMatchObject({ created: 1, skipped: 1 });
  });

  it('link contact lists to donors already on file without changing them, and flag differences', async () => {
    await sql(db, `update public.donors set phone = '845-555-1111', address = '1 Old Rd' where id = 'd1'`);
    const r = await run(db, 'contacts', [
      { first_name: 'Donor', last_name: 'One', phone: '(845) 555 1111', address: '9 New Ave' },
      { first_name: 'Fresh', last_name: 'Contact', phone: '845-555-2222' },
    ], { campaign: '1001' }, true, MANAGER_1);
    expect(r).toMatchObject({ linked: 1, created: 1, conflicts: 1 });
    expect(r.rows[0].message).toBe('Matched by phone');
    expect((await one(db, `select address from public.donors where id = 'd1'`)).address).toBe('1 Old Rd');
    expect(await count(db, 'fundraiser_donors', `manager_id = 'm1'`)).toBeGreaterThanOrEqual(2);
    const task = await one(db, `select task_type, summary from public.admin_task_sheet where task_type = 'import_conflict'`);
    expect(task.summary).toMatch(/Donor One: the contact list has different details \(matched by phone\)/);
    const c = await one(db, `select id, imported, on_file from public.import_conflicts`);
    expect(c.imported.address).toBe('9 New Ave');
    expect(c.on_file.address).toBe('1 Old Rd');
    await sql(db, `select public.resolve_import_conflict($1)`, [c.id]);
    expect(await rows(db, ADMIN, `select 1 from public.admin_task_sheet where task_type = 'import_conflict'`)).toEqual([]);
    expect((await rows(db, MANAGER_1, `select id from public.imports`)).length).toBe(1);
    expect(await rows(db, MANAGER_2, `select id from public.imports`)).toEqual([]);
  });

  it('reverse within 24 hours, taking the money back out', async () => {
    const before = await balance(db, '1002');
    await run(db, 'donations', [{ donor_name: 'Temp Person', campaign_id: '1002', amount: '75', date: '2025-05-05' }]);
    const imp = (await one(db, `select id from public.imports`)).id;
    await expect(sql(db, `select public.reverse_import($1)`, [imp], MANAGER_2)).rejects.toThrow(/Super Admin/);
    await sql(db, `select public.reverse_import($1)`, [imp]);
    expect(await balance(db, '1002')).toBeCloseTo(before, 2);
    expect(await count(db, 'donors', `display_name = 'Temp Person'`)).toBe(0);
    await expect(sql(db, `select public.reverse_import($1)`, [imp])).rejects.toThrow(/already reversed/);
  });

  it('refuse reversal after a day, or once something was built on it', async () => {
    await run(db, 'donors', [{ first_name: 'Kept', last_name: 'Donor' }]);
    const imp = (await one(db, `select id from public.imports`)).id;
    const donor = (await one(db, `select id from public.donors where display_name = 'Kept Donor'`)).id;
    await sql(db, `insert into public.donations (campaign_id, donor_id, amount, type, status) values ('1001', $1, 10, 'Payment', 'completed')`, [donor]);
    await expect(sql(db, `select public.reverse_import($1)`, [imp])).rejects.toThrow(/since been entered/);
    await db.query(`update public.imports set imported_at = now() - interval '25 hours'`);
    await expect(sql(db, `select public.reverse_import($1)`, [imp])).rejects.toThrow(/24 hours/);
  });
});

describe('source report and directory', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); });

  it('tags each payment with its source', async () => {
    await sql(db, `insert into public.donations (campaign_id, amount, type, status, payment_method, source) values ('1001', 20, 'Payment', 'completed', 'OJC', 'Manual'), ('1001', 30, 'Payment', 'completed', 'Zelle', 'Manual')`);
    await sql(db, `insert into public.sources (id, name) values ('DP_1', 'Oizer #3')`);
    await sql(db, `select public.register_machine('DP_1', 3, null, null, 'DP_1')`);
    await sql(db, `insert into public.donations (campaign_id, amount, type, status, source) values ('1001', 40, 'Payment', 'completed', 'DP_1')`);
    const tags = (await rows<{ source_tag: string; source_category: string }>(db, ADMIN, `select source_tag, source_category from public.source_lines where amount in (20, 30, 40) order by amount`));
    expect(tags).toEqual([
      { source_tag: 'DAF — OJC', source_category: 'DAF' },
      { source_tag: 'Manual — Zelle', source_category: 'Manual' },
      { source_tag: 'Donary — Machine 3', source_category: 'Donary Machines' },
    ]);
    expect((await rows(db, MANAGER_2, `select id from public.source_lines where campaign_id = '1001'`))).toEqual([]);
  });

  it('lists fundraisers with their role on each campaign, for admins', async () => {
    const dir = await rows<Record<string, any>>(db, ADMIN, `select * from public.fundraiser_directory()`);
    const m1 = dir.find(d => d.id === 'm1');
    expect(m1.campaigns).toEqual(expect.arrayContaining([expect.objectContaining({ id: '1001', role: 'Primary' }), expect.objectContaining({ id: '1003', role: 'Secondary' })]));
    expect(await rows(db, MANAGER_1, `select * from public.fundraiser_directory()`)).toEqual([]);
  });
});
