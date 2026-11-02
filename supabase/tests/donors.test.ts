import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, MANAGER_1, MANAGER_2, as, rows, seededDb } from './harness';

const sql = (db: PGlite, q: string, params: unknown[] = [], user = ADMIN) => as(db, user, tx => tx.query(q, params));
const one = async <T = Record<string, any>>(db: PGlite, q: string, params: unknown[] = [], user = ADMIN) => (await rows<T>(db, user, q, params))[0];
const donor = async (db: PGlite, first: string, last: string, phone: string | null = null) =>
  (await one<{ id: string }>(db, `insert into public.donors (first_name, last_name, phone) values ($1, $2, $3) returning id`, [first, last, phone])).id;
const lookup = (db: PGlite, q: string, user = MANAGER_1) => rows<Record<string, any>>(db, user, `select * from public.lookup_donors($1)`, [q]);
const give = async (db: PGlite, campaign: string, donorId: string, amount = 100) =>
  (await one<{ id: string }>(db, `insert into public.donations (campaign_id, donor_id, amount, type, status) values ($1, $2, $3, 'Payment', 'completed') returning id`, [campaign, donorId, amount])).id;

describe('donor lookup', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); });

  it('finds any donor in the organization by name, phone or ID', async () => {
    const id = await donor(db, 'Moshe', 'Goldstein', '(845) 555-1212');
    expect((await lookup(db, 'goldst')).map(r => r.id)).toEqual([id]);
    expect((await lookup(db, '555-1212')).map(r => r.id)).toEqual([id]);
    expect((await lookup(db, id)).map(r => r.id)).toEqual([id]);
    expect((await lookup(db, 'goldst'))[0].on_my_list).toBe(false);
  });

  it('answers only a real search, never the whole list', async () => {
    await donor(db, 'A', 'B');
    expect(await lookup(db, '')).toEqual([]);
    expect(await lookup(db, 'o')).toEqual([]);
    for (let i = 0; i < 25; i++) await donor(db, 'Same', `Name${i}`);
    expect((await lookup(db, 'same')).length).toBe(20);
  });

  it('is for admins and fundraisers', async () => {
    await expect(rows(db, 'anon', `select * from public.lookup_donors('xx')`)).rejects.toThrow();
  });

  it('links a found donor, and their other giving stays hidden', async () => {
    const id = await donor(db, 'Moshe', 'Goldstein');
    await give(db, '1002', id, 500);
    expect(await rows(db, MANAGER_1, `select id from public.donor_summary where id = $1`, [id])).toEqual([]);
    await sql(db, `select public.link_donor($1)`, [id], MANAGER_1);
    const s = await one(db, `select total_given, gift_count, display_name from public.donor_summary where id = $1`, [id], MANAGER_1);
    expect(s).toMatchObject({ display_name: 'Moshe Goldstein', total_given: '0' });
    expect(await rows(db, MANAGER_1, `select id from public.donations where donor_id = $1`, [id])).toEqual([]);
    expect((await lookup(db, 'goldst'))[0].on_my_list).toBe(true);
    await give(db, '1001', id, 40);
    expect((await one(db, `select total_given from public.donor_summary where id = $1`, [id], MANAGER_1)).total_given).toBe('40.00');
    expect((await one(db, `select total_given from public.donor_summary where id = $1`, [id])).total_given).toBe('540.00');
  });

  it('lets a fundraiser add a donor, who is then on their list only', async () => {
    const [{ id }] = await rows<{ id: string }>(db, MANAGER_1, `select public.add_fundraiser_donor('{"first_name":"New","last_name":"Person","country":"IL","phone":"+972501234567"}'::jsonb) as id`);
    expect(await one(db, `select display_name, country from public.donor_summary where id = $1`, [id], MANAGER_1)).toEqual({ display_name: 'New Person', country: 'IL' });
    expect(await rows(db, MANAGER_2, `select id from public.donors where id = $1`, [id])).toEqual([]);
    await expect(sql(db, `select public.add_fundraiser_donor('{"first_name":"Only"}'::jsonb)`, [], MANAGER_1)).rejects.toThrow(/first and last/);
  });

  it('lets a fundraiser edit contact details but not admin notes', async () => {
    const id = await donor(db, 'Moshe', 'Goldstein');
    await sql(db, `select public.link_donor($1)`, [id], MANAGER_1);
    await sql(db, `update public.donors set phone = '555' where id = $1`, [id], MANAGER_1);
    expect((await one(db, `select phone from public.donors where id = $1`, [id])).phone).toBe('555');
    await expect(sql(db, `update public.donors set notes = 'x' where id = $1`, [id], MANAGER_1)).rejects.toThrow(/Only admins/);
    const other = await donor(db, 'Not', 'Mine');
    await sql(db, `update public.donors set phone = '1' where id = $1`, [other], MANAGER_1);
    expect((await one(db, `select phone from public.donors where id = $1`, [other])).phone).toBeNull();
  });

  it('adds up open pledges', async () => {
    const id = await donor(db, 'Moshe', 'Goldstein');
    await sql(db, `insert into public.pledges (campaign_id, donor_id, amount) values ('1001', $1, 300), ('1002', $1, 200)`, [id]);
    expect((await one(db, `select open_pledges from public.donor_summary where id = $1`, [id])).open_pledges).toBe('500.00');
  });
});

describe('contact log', () => {
  let db: PGlite;
  let id: string;
  beforeEach(async () => {
    db = await seededDb();
    id = await donor(db, 'Moshe', 'Goldstein');
  });
  const log = (user: string, notes = 'Left a message') =>
    sql(db, `select public.add_donor_contact($1, 'Call', 'Voicemail', $2)`, [id, notes], user);

  it('needs the donor on your list', async () => {
    await expect(log(MANAGER_1)).rejects.toThrow(/isn't on your list/);
    await sql(db, `select public.link_donor($1)`, [id], MANAGER_1);
    await log(MANAGER_1);
    expect(await one(db, `select method, outcome, notes, manager_id, created_by from public.donor_contacts`))
      .toEqual({ method: 'Call', outcome: 'Voicemail', notes: 'Left a message', manager_id: 'm1', created_by: 'one@example.org' });
  });

  it('shows a fundraiser only their own and their team\'s entries, and admins everything', async () => {
    await sql(db, `select public.link_donor($1)`, [id], MANAGER_1);
    await sql(db, `select public.link_donor($1)`, [id], MANAGER_2);
    await log(MANAGER_1, 'From one');
    await log(ADMIN, 'From office');
    // m1 and m2 share campaign 1003, so they are one team.
    const seen = async (u: string) => (await rows<{ notes: string }>(db, u, `select notes from public.donor_contacts order by notes`)).map(r => r.notes);
    expect(await seen(MANAGER_2)).toEqual(['From one']);
    await sql(db, `update public.campaigns set sub_manager_ids = '{}' where id = '1003'`);
    await sql(db, `update public.campaigns set manager_id = 'm2' where id = '1003'`);
    expect(await seen(MANAGER_2)).toEqual([]);
    expect(await seen(MANAGER_1)).toEqual(['From one']);
    expect(await seen(ADMIN)).toEqual(['From office', 'From one']);
  });

  it('is permanent', async () => {
    await log(ADMIN);
    await expect(sql(db, `update public.donor_contacts set notes = 'x'`)).rejects.toThrow();
    await expect(sql(db, `delete from public.donor_contacts`)).rejects.toThrow();
  });

  it('checks method and outcome', async () => {
    await expect(sql(db, `select public.add_donor_contact($1, 'Fax', 'Reached')`, [id])).rejects.toThrow();
    await expect(sql(db, `select public.add_donor_contact($1, 'Call', 'Maybe')`, [id])).rejects.toThrow();
  });
});

describe('duplicates and merging', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); });
  const dupes = () => rows<Record<string, any>>(db, ADMIN, `select * from public.donor_duplicates`);

  it('flags the same name or phone, for admins only', async () => {
    const a = await donor(db, 'Moshe', 'Goldstein', '845-555-1212');
    const b = await donor(db, 'moshe', 'goldstein');
    const c = await donor(db, 'M', 'G', '+1 (845) 555 1212');
    const list = await dupes();
    expect(list.find(d => d.reason === 'Same name').donors.map((x: Row) => x.id).sort()).toEqual([a, b].sort());
    expect(list.find(d => d.reason === 'Same phone').donors.map((x: Row) => x.id).sort()).toEqual([a, c].sort());
    expect(await rows(db, MANAGER_1, `select * from public.donor_duplicates`)).toEqual([]);
  });

  it('can be dismissed', async () => {
    await donor(db, 'Moshe', 'Goldstein');
    await donor(db, 'Moshe', 'Goldstein');
    const [d] = await dupes();
    await sql(db, `select public.dismiss_donor_duplicate($1)`, [d.match_key]);
    expect(await dupes()).toEqual([]);
  });

  it('moves everything to the survivor, with blanks filled, balances unmoved', async () => {
    const keep = await donor(db, 'Moshe', 'Goldstein');
    const gone = await donor(db, 'M', 'Goldstein', '555-0000');
    await sql(db, `update public.donors set notes = 'Kept' where id = $1`, [keep]);
    await sql(db, `update public.donors set notes = 'Absorbed', ojc_id = 'OJC1' where id = $1`, [gone]);
    await give(db, '1003', keep, 100);
    await give(db, '1003', gone, 50);
    const [{ id: pledge }] = await rows<{ id: string }>(db, ADMIN, `insert into public.pledges (campaign_id, donor_id, amount) values ('1001', $1, 10) returning id`, [gone]);
    const [{ id: task }] = await rows<{ id: string }>(db, ADMIN, `insert into public.tasks (title, donor_id) values ('Call', $1) returning id`, [gone]);
    await sql(db, `select public.add_donor_contact($1, 'Call', 'Reached')`, [gone]);
    const [{ id: list }] = await rows<{ id: string }>(db, ADMIN, `select public.create_call_list('L', array[$1, $2]) as id`, [keep, gone]);
    const before = (await one(db, `select balance from public.campaign_summary where id = '1003'`)).balance;

    await sql(db, `select public.merge_donors($1, $2)`, [keep, gone]);

    const s = await one(db, `select * from public.donor_summary where id = $1`, [keep]);
    expect(s).toMatchObject({ display_name: 'Moshe Goldstein', phone: '555-0000', ojc_id: 'OJC1', total_given: '150.00', gift_count: 2, notes: 'Kept\nAbsorbed' });
    expect(await rows(db, ADMIN, `select id from public.donors where id = $1`, [gone])).toEqual([]);
    expect((await one(db, `select donor_id from public.pledges where id = $1`, [pledge])).donor_id).toBe(keep);
    expect((await one(db, `select donor_id from public.tasks where id = $1`, [task])).donor_id).toBe(keep);
    expect((await rows(db, ADMIN, `select id from public.donor_contacts where donor_id = $1`, [keep])).length).toBe(1);
    expect((await rows(db, ADMIN, `select donor_id from public.task_call_items where task_id = $1`, [list])).map((r: Row) => r.donor_id)).toEqual([keep]);
    expect((await one(db, `select balance from public.campaign_summary where id = '1003'`)).balance).toBe(before);
    expect(await one(db, `select kept_id, absorbed_id, merged_by from public.donor_merges`)).toEqual({ kept_id: keep, absorbed_id: gone, merged_by: 'office@example.org' });
  });

  it('carries a fundraiser\'s link over', async () => {
    const keep = await donor(db, 'A', 'One');
    const gone = await donor(db, 'A', 'Two');
    await sql(db, `select public.link_donor($1)`, [gone], MANAGER_1);
    await sql(db, `select public.merge_donors($1, $2)`, [keep, gone]);
    expect((await rows(db, MANAGER_1, `select id from public.donors where id = $1`, [keep])).length).toBe(1);
  });

  it('is final, and for admins only', async () => {
    const keep = await donor(db, 'A', 'One');
    const gone = await donor(db, 'A', 'Two');
    await expect(sql(db, `select public.merge_donors($1, $2)`, [keep, gone], MANAGER_1)).rejects.toThrow(/Only admins/);
    await expect(sql(db, `select public.merge_donors($1, $1)`, [keep])).rejects.toThrow(/two different/);
    await sql(db, `select public.merge_donors($1, $2)`, [keep, gone]);
    await expect(sql(db, `select public.merge_donors($1, $2)`, [keep, gone])).rejects.toThrow(/not found/);
    await expect(sql(db, `select public.restore_record('donors', $1)`, [gone])).rejects.toThrow(/merged/);
  });
});

describe('dashboard numbers', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); });
  const stats = async (user = ADMIN, from = '2020-01-01', to = '2099-01-01') =>
    (await one<{ s: Record<string, any> }>(db, `select public.dashboard_stats($1, $2) as s`, [from, to], user)).s;

  it('adds up today and the range, with fees', async () => {
    const before = await stats();
    await sql(db, `insert into public.donations (campaign_id, amount, fee, type, status) values ('1001', 100, 3, 'Payment', 'completed')`);
    await sql(db, `insert into public.donations (campaign_id, amount, type, status) values ('1001', 900, 'Payment', 'voided')`);
    const s = await stats();
    expect(Number(s.periods.today.raised) - Number(before.periods.today.raised)).toBe(100);
    expect(Number(s.periods.today.fees) - Number(before.periods.today.fees)).toBe(3);
    expect(Number(s.range.raised) - Number(before.range.raised)).toBe(100);
    expect(s.daily.length).toBeGreaterThan(0);
  });

  it('respects the date range', async () => {
    await sql(db, `insert into public.donations (campaign_id, amount, type, status, created_at) values ('1001', 77, 'Payment', 'completed', '2021-06-15 16:00+00')`);
    const s = await stats(ADMIN, '2021-06-15', '2021-06-15');
    expect(Number(s.range.raised)).toBe(77);
    expect(s.daily).toEqual([{ day: '2021-06-15', total: 77 }]);
    expect(Number((await stats(ADMIN, '2021-06-16', '2021-06-20')).range.raised)).toBe(0);
  });

  it('gives a fundraiser only their own campaigns', async () => {
    await sql(db, `insert into public.donations (campaign_id, amount, type, status) values ('1002', 5000, 'Payment', 'completed')`);
    const mine = await stats(MANAGER_1);
    expect(mine.top_campaigns.map((c: Row) => c.id)).not.toContain('1002');
    expect((await stats(MANAGER_2)).top_campaigns.map((c: Row) => c.id)).toContain('1002');
    expect(Number(mine.range.raised)).toBeLessThan(Number((await stats()).range.raised));
  });

  it('counts pledged money apart from raised', async () => {
    await sql(db, `insert into public.pledges (campaign_id, amount) values ('1003', 250)`);
    expect(Number((await stats()).pledged)).toBeGreaterThanOrEqual(250);
  });
});

type Row = Record<string, any>;
