import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, MANAGER_1, MANAGER_2, as, rows, seededDb } from './harness';

const sql = (db: PGlite, q: string, params: unknown[] = [], user = ADMIN) => as(db, user, tx => tx.query(q, params));
const one = async <T = Record<string, any>>(db: PGlite, q: string, params: unknown[] = [], user = ADMIN) => (await rows<T>(db, user, q, params))[0];
const template = async (db: PGlite, name = 'Annual Dinner', extra = `'he', '{18,36,180}', true, 25`) =>
  (await one<{ id: string }>(db, `insert into public.campaign_templates (name, language, preset_amounts, cover_fee_default, min_donation) values ($1, ${extra}) returning id`, [name])).id;
const task = async (db: PGlite, user: string, values: Record<string, unknown>) => {
  const keys = Object.keys(values);
  return (await one<{ id: string }>(db, `insert into public.tasks (${keys.join(',')}) values (${keys.map((_, i) => `$${i + 1}`).join(',')}) returning id`, Object.values(values), user)).id;
};

describe('campaign templates', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); });

  it('are managed by admins, readable by fundraisers', async () => {
    const id = await template(db);
    await expect(sql(db, `insert into public.campaign_templates (name) values ('x')`, [], MANAGER_1)).rejects.toThrow();
    await sql(db, `update public.campaign_templates set name = 'x' where id = $1`, [id], MANAGER_1);
    expect((await one(db, `select name from public.campaign_templates where id = $1`, [id])).name).toBe('Annual Dinner');
    expect((await rows(db, MANAGER_1, `select id from public.campaign_templates`)).length).toBe(1);
  });

  it('have unique names', async () => {
    await template(db, 'Standard');
    await expect(template(db, 'standard')).rejects.toThrow();
  });

  it('have one default at a time, which can\'t be deleted', async () => {
    const a = await template(db, 'A');
    const b = await template(db, 'B');
    await sql(db, `select public.set_default_template($1)`, [a]);
    await sql(db, `select public.set_default_template($1)`, [b]);
    const defaults = await rows<{ id: string }>(db, ADMIN, `select id from public.campaign_templates where is_default`);
    expect(defaults.map(r => r.id)).toEqual([b]);
    await expect(sql(db, `delete from public.campaign_templates where id = $1`, [b])).rejects.toThrow(/default template/);
    await sql(db, `delete from public.campaign_templates where id = $1`, [a]);
    expect(await rows(db, ADMIN, `select id from public.campaign_templates where id = $1`, [a])).toEqual([]);
    await sql(db, `select public.set_default_template(null)`);
    await sql(db, `delete from public.campaign_templates where id = $1`, [b]);
  });

  it('fill a new campaign\'s settings, and later edits don\'t reach it', async () => {
    const id = await template(db);
    await sql(db, `select public.save_campaign_settings('1003', null, $1)`, [id]);
    const before = await one(db, `select * from public.campaign_page_settings where campaign_id = '1003'`);
    expect(before).toMatchObject({ language: 'he', cover_fee_default: true, min_donation: '25.00', template_id: id });
    await sql(db, `update public.campaign_templates set language = 'yi', min_donation = 99 where id = $1`, [id]);
    expect((await one(db, `select language from public.campaign_page_settings where campaign_id = '1003'`)).language).toBe('he');
  });

  it('let the admin override any setting before saving', async () => {
    const id = await template(db);
    await sql(db, `select public.save_campaign_settings('1003', $1::jsonb, $2)`, [JSON.stringify({ language: 'en', preset_amounts: [100], donor_wall: true }), id]);
    expect(await one(db, `select language, donor_wall, template_id from public.campaign_page_settings where campaign_id = '1003'`))
      .toEqual({ language: 'en', donor_wall: true, template_id: id });
  });

  it('bring their bank account and fees, without replacing what the campaign set', async () => {
    await sql(db, `insert into public.accounts (id, name) values ('b2', 'Second'), ('b3', 'Third')`);
    const [m] = await rows<{ id: string }>(db, ADMIN, `select id from public.payment_methods where name = 'Wire'`);
    const id = (await one<{ id: string }>(db, `insert into public.campaign_templates (name, account_id, fee_overrides) values ('T', 'b2', $1::jsonb) returning id`,
      [JSON.stringify([{ method_id: m.id, fee_type: 'percent', fee_percent: 2 }])])).id;
    await sql(db, `select public.save_campaign_settings('1003', null, $1)`, [id]);
    expect((await one(db, `select account_id from public.campaigns where id = '1003'`)).account_id).toBe('b2');
    expect((await one<{ f: string }>(db, `select public.calculate_fee(org_id, '1003', 'Wire', 100) f from public.campaigns where id = '1003'`)).f).toBe('2.00');

    await sql(db, `update public.campaigns set account_id = 'b3' where id = '1001'`);
    await sql(db, `insert into public.campaign_fee_overrides (campaign_id, method_id, fee_type, fee_percent) values ('1001', $1, 'percent', 7)`, [m.id]);
    await sql(db, `select public.save_campaign_settings('1001', null, $1)`, [id]);
    expect((await one(db, `select account_id from public.campaigns where id = '1001'`)).account_id).toBe('b3');
    expect((await one<{ f: string }>(db, `select public.calculate_fee(org_id, '1001', 'Wire', 100) f from public.campaigns where id = '1001'`)).f).toBe('7.00');
  });

  it('work for sub-campaigns made by the primary fundraiser', async () => {
    const id = await template(db);
    const sub = (await one<{ id: string }>(db, `select public.add_sub_campaign('1002', 'Table', 'shared') as id`, [], MANAGER_2)).id;
    await sql(db, `select public.save_campaign_settings($1, null, $2)`, [sub, id], MANAGER_2);
    expect((await one(db, `select language from public.campaign_page_settings where campaign_id = $1`, [sub])).language).toBe('he');
    await expect(sql(db, `select public.save_campaign_settings('1002', null, $1)`, [id], MANAGER_1)).rejects.toThrow(/primary fundraiser/);
  });

  it('settings are read by the campaign team only, and changed through the function', async () => {
    await sql(db, `select public.save_campaign_settings('1002', '{"language":"yi"}'::jsonb)`);
    expect((await rows(db, MANAGER_2, `select campaign_id from public.campaign_page_settings`)).length).toBe(1);
    expect(await rows(db, MANAGER_1, `select campaign_id from public.campaign_page_settings`)).toEqual([]);
    await expect(sql(db, `update public.campaign_page_settings set language = 'en'`)).rejects.toThrow();
  });
});

describe('fundraiser tasks', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); });

  it('are private to the fundraiser and admins', async () => {
    const id = await task(db, MANAGER_1, { title: 'Call Moshe', campaign_id: '1003' });
    expect((await one(db, `select owner_manager_id from public.tasks where id = $1`, [id])).owner_manager_id).toBe('m1');
    expect((await rows(db, MANAGER_2, `select id from public.tasks where id = $1`, [id]))).toEqual([]);
    expect((await rows(db, ADMIN, `select id from public.tasks where id = $1`, [id])).length).toBe(1);
  });

  it('need no campaign, but can only name their own', async () => {
    const id = await task(db, MANAGER_1, { title: 'Personal' });
    expect((await rows(db, MANAGER_1, `select id from public.tasks where id = $1`, [id])).length).toBe(1);
    await expect(task(db, MANAGER_1, { title: 'Other', campaign_id: '1002' })).rejects.toThrow();
  });

  it("can't be claimed for someone else", async () => {
    const id = await task(db, MANAGER_1, { title: 'Mine', owner_manager_id: 'm2' });
    expect((await one(db, `select owner_manager_id from public.tasks where id = $1`, [id])).owner_manager_id).toBe('m1');
    await expect(sql(db, `update public.tasks set owner_manager_id = 'm2' where id = $1`, [id], MANAGER_1)).rejects.toThrow(/moved/);
  });

  it('can be done, edited and deleted by their owner', async () => {
    const id = await task(db, MANAGER_1, { title: 'Mine' });
    await sql(db, `update public.tasks set status = 'Done' where id = $1`, [id], MANAGER_1);
    await sql(db, `delete from public.tasks where id = $1`, [id], MANAGER_1);
    expect(await rows(db, MANAGER_1, `select id from public.tasks where id = $1`, [id])).toEqual([]);
    expect((await db.query<{ deleted_by: string }>(`select deleted_by from public.tasks where id = $1`, [id])).rows[0].deleted_by).toBe('one@example.org');
  });

  it("can't be changed or deleted by an admin, who can still see them", async () => {
    const id = await task(db, MANAGER_1, { title: 'Mine' });
    await expect(sql(db, `update public.tasks set status = 'Done' where id = $1`, [id])).rejects.toThrow(/personal task/);
    await expect(sql(db, `delete from public.tasks where id = $1`, [id])).rejects.toThrow(/personal task/);
  });

  it('can be made by an admin on behalf of a fundraiser, who sees it', async () => {
    const id = await task(db, ADMIN, { title: 'Please call', owner_manager_id: 'm1' });
    expect((await rows(db, MANAGER_1, `select id from public.tasks where id = $1`, [id])).length).toBe(1);
    expect(await rows(db, MANAGER_2, `select id from public.tasks where id = $1`, [id])).toEqual([]);
    await sql(db, `update public.tasks set title = 'Please call today' where id = $1`, [id]);
    await sql(db, `update public.tasks set status = 'Done' where id = $1`, [id], MANAGER_1);
  });

  it('with no owner stay shared on the campaign, and only admins delete them', async () => {
    expect((await rows<{ id: string }>(db, MANAGER_1, `select id from public.tasks`)).map(r => r.id)).toContain('k1');
    await sql(db, `update public.tasks set status = 'Done' where id = 'k1'`, [], MANAGER_1);
    await sql(db, `update public.tasks set status = 'Pending' where id = 'k1'`);
    await sql(db, `delete from public.tasks where id = 'k1'`);
  });

  it('from an overdue pledge belong to the fundraiser who made them', async () => {
    const p = (await one<{ id: string }>(db, `insert into public.pledges (campaign_id, amount, name) values ('1001', 50, 'Moshe') returning id`)).id;
    const t = (await one<{ t: string }>(db, `select public.pledge_to_task($1) as t`, [p], MANAGER_1)).t;
    expect((await one(db, `select owner_manager_id from public.tasks where id = $1`, [t])).owner_manager_id).toBe('m1');
  });
});

describe('call lists', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); });
  const list = async (user = MANAGER_1, donors = ['d1']) =>
    (await one<{ id: string }>(db, `select public.create_call_list('After the dinner', $1, '1001', '2030-01-01') as id`, [donors], user)).id;
  const items = (id: string, user = ADMIN) => rows<Record<string, any>>(db, user, `select * from public.task_call_items where task_id = $1 order by donor_id`, [id]);

  it('hold the fundraiser\'s donors, as a private task', async () => {
    const id = await list();
    expect(await one(db, `select is_call_list, owner_manager_id, title from public.tasks where id = $1`, [id]))
      .toEqual({ is_call_list: true, owner_manager_id: 'm1', title: 'After the dinner' });
    expect((await items(id)).map(i => i.donor_id)).toEqual(['d1']);
    expect(await rows(db, MANAGER_2, `select id from public.task_call_items where task_id = $1`, [id])).toEqual([]);
    expect((await items(id, MANAGER_1)).length).toBe(1);
  });

  it("can't include a donor the fundraiser has no access to", async () => {
    const seen = await rows<{ id: string }>(db, MANAGER_1, `select id from public.donors`);
    const hidden = ['d1', 'd2'].find(d => !seen.some(s => s.id === d));
    if (hidden) await expect(list(MANAGER_1, [hidden])).rejects.toThrow(/available/);
    await expect(sql(db, `select public.create_call_list('x', '{}')`, [], MANAGER_1)).rejects.toThrow(/at least one/);
    await expect(sql(db, `select public.create_call_list(' ', '{d1}')`, [], MANAGER_1)).rejects.toThrow(/needs a name/);
  });

  it('are checked off with a note per donor', async () => {
    const id = await list();
    const [i] = await items(id);
    await sql(db, `select public.set_call_item($1, true, 'Left voicemail')`, [i.id], MANAGER_1);
    expect((await items(id))[0]).toMatchObject({ contacted: true, note: 'Left voicemail', contacted_by: 'one@example.org' });
    await sql(db, `select public.set_call_item($1, false, 'Will pay Sunday')`, [i.id], MANAGER_1);
    expect((await items(id))[0]).toMatchObject({ contacted: false, note: 'Will pay Sunday', contacted_at: null });
  });

  it("can't be worked by anyone else, including admins on someone's own list", async () => {
    const id = await list();
    const [i] = await items(id);
    await expect(sql(db, `select public.set_call_item($1, true)`, [i.id], MANAGER_2)).rejects.toThrow(/someone else/);
    await expect(sql(db, `select public.set_call_item($1, true)`, [i.id])).rejects.toThrow(/someone else/);
    await expect(sql(db, `select public.add_call_items($1, '{d2}')`, [id], MANAGER_2)).rejects.toThrow(/isn't yours/);
  });

  it('can be made by an admin for a fundraiser', async () => {
    const id = (await one<{ id: string }>(db, `select public.create_call_list('For you', '{d1,d2}', null, null, null, 'm1') as id`)).id;
    expect((await items(id)).length).toBe(2);
    expect((await items(id, MANAGER_1)).length).toBe(2);
    const [i] = await items(id);
    await sql(db, `select public.set_call_item($1, true)`, [i.id]);
  });
});

describe('changing a campaign to another template', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); });

  it('takes the new template’s page settings and keeps everything else about the campaign', async () => {
    const dinner = await template(db, 'Annual Dinner', `'he', '{18,36,180}', true, 25`);
    const gala = await template(db, 'Gala', `'yi', '{100,250,500}', false, 50`);
    await sql(db, `update public.campaign_templates set donor_wall = true, custom_fields = '[{"name":"Table","type":"text"}]' where id = $1`, [gala]);
    await sql(db, `select public.save_campaign_settings('1001', null, $1)`, [dinner]);
    // The campaign's own page text and a donation, which must survive the switch.
    await db.query(`update public.campaign_page_settings set description = 'Our story', thank_you = 'Thanks!', banner_url = 'https://example.org/b.jpg', suggested_amount = 36 where campaign_id = '1001'`);
    const before = await one(db, `select internal_name, manager_id, goal, account_id, status, (select count(*) from public.donations d where d.campaign_id = '1001' and d.deleted_at is null) as gifts,
                                         (select sum(amount) from public.donations d where d.campaign_id = '1001' and d.deleted_at is null) as total
                                  from public.campaigns where id = '1001'`);

    await sql(db, `select public.switch_campaign_template('1001', $1)`, [gala]);

    const s = await one(db, `select template_id, language, preset_amounts, cover_fee_default, min_donation, donor_wall, custom_fields,
                                    description, thank_you, banner_url, suggested_amount from public.campaign_page_settings where campaign_id = '1001'`);
    expect(s).toMatchObject({ template_id: gala, language: 'yi', cover_fee_default: false, donor_wall: true,
      description: 'Our story', thank_you: 'Thanks!', banner_url: 'https://example.org/b.jpg' });
    expect(s.preset_amounts.map(Number)).toEqual([100, 250, 500]);
    expect(Number(s.min_donation)).toBe(50);
    expect(Number(s.suggested_amount)).toBe(36);
    expect(s.custom_fields).toEqual([{ name: 'Table', type: 'text' }]);
    expect(await one(db, `select internal_name, manager_id, goal, account_id, status, (select count(*) from public.donations d where d.campaign_id = '1001' and d.deleted_at is null) as gifts,
                                 (select sum(amount) from public.donations d where d.campaign_id = '1001' and d.deleted_at is null) as total
                          from public.campaigns where id = '1001'`)).toEqual(before);
    expect((await db.query<Record<string, any>>(`select changes from public.activity_log where action = 'campaign_template_changed' order by id desc limit 1`)).rows[0])
      .toMatchObject({ changes: { from: dinner, to: gala, to_name: 'Gala' } });
  });

  it('works for a campaign that never had a template, and only for admins and live templates', async () => {
    const gala = await template(db, 'Gala');
    await sql(db, `select public.switch_campaign_template('1002', $1)`, [gala]);
    expect((await one(db, `select template_id from public.campaign_page_settings where campaign_id = '1002'`)).template_id).toBe(gala);
    await expect(sql(db, `select public.switch_campaign_template('1002', $1)`, [gala], MANAGER_1)).rejects.toThrow();
    await sql(db, `delete from public.campaign_templates where id = $1`, [gala]);
    await expect(sql(db, `select public.switch_campaign_template('1002', $1)`, [gala])).rejects.toThrow(/Template not found/);
    await expect(sql(db, `select public.switch_campaign_template('nope', $1)`, [gala])).rejects.toThrow(/Campaign not found/);
  });
});
