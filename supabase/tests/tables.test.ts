import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, MANAGER_1, MANAGER_2, as, ids, rows, seededDb } from './harness';

const OTHER = '00000000-0000-4000-8000-0000000000bb';
const OTHER_ADMIN = '00000000-0000-0000-0000-0000000000b1';

async function withOtherOrg(db: PGlite) {
  await db.exec(`
    insert into public.organizations (id, slug, name) values ('${OTHER}', 'other', 'Other Org');
    insert into auth.users (id, email) values ('${OTHER_ADMIN}', 'admin@other.org');
    insert into public.org_members (org_id, user_id, role) values ('${OTHER}', '${OTHER_ADMIN}', 'super_admin');
    insert into public.campaigns (org_id, id, internal_name) values ('${OTHER}', '1001', 'Theirs');
    insert into public.donations (org_id, id, campaign_id, amount) values ('${OTHER}', 'p1', '1001', 77);
  `);
}

describe('saved views', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); });
  const save = (user: string, name: string, isDefault = false) => rows<{ id: string }>(db, user,
    `insert into public.saved_views (table_key, name, config, is_default) values ('Donors', $1, '{"compact":true}', $2) returning id`, [name, isDefault]);

  it('belong to the person who saved them', async () => {
    await save(MANAGER_1, 'Mine');
    expect(await rows(db, MANAGER_1, `select name, config from public.saved_views`)).toEqual([{ name: 'Mine', config: { compact: true } }]);
    expect(await rows(db, MANAGER_2, `select name from public.saved_views`)).toEqual([]);
    expect(await rows(db, ADMIN, `select name from public.saved_views`)).toEqual([]);
  });

  it("can't be saved as, or changed for, someone else", async () => {
    await expect(rows(db, MANAGER_1, `insert into public.saved_views (user_id, table_key, name) values ('${MANAGER_2}', 'x', 'y')`)).rejects.toThrow(/row-level security/);
    const [{ id }] = await save(MANAGER_1, 'Mine');
    expect(await rows(db, MANAGER_2, `update public.saved_views set name = 'Hacked' where id = $1 returning id`, [id])).toEqual([]);
    expect(await rows(db, MANAGER_2, `delete from public.saved_views where id = $1 returning id`, [id])).toEqual([]);
  });

  it('allow one default per table per person', async () => {
    await save(MANAGER_1, 'A', true);
    await expect(save(MANAGER_1, 'B', true)).rejects.toThrow(/saved_views_one_default/);
    await save(MANAGER_2, 'A', true);
  });

  it('are closed to anonymous visitors', async () => {
    await expect(rows(db, 'anon', `select 1 from public.saved_views`)).rejects.toThrow(/permission denied/);
  });
});

describe('transaction list', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); await withOtherOrg(db); });

  it('has related names as plain columns', async () => {
    const [r] = await rows(db, ADMIN, `select campaign_internal, campaign_external, donor_name, amount, status from public.transaction_list where id = 'p1'`);
    expect(r).toEqual({ campaign_internal: 'First campaign', campaign_external: 'First campaign', donor_name: 'Donor One', amount: '1000.00', status: 'completed' });
  });

  it('applies the same limits as the donations themselves', async () => {
    expect(ids(await rows(db, MANAGER_2, `select id from public.transaction_list`))).toEqual(['b1', 'p3']);
    expect(ids(await rows(db, OTHER_ADMIN, `select id from public.transaction_list`))).toEqual(['p1']);
    expect((await rows<{ amount: string }>(db, OTHER_ADMIN, `select amount from public.transaction_list`))[0].amount).toBe('77.00');
    await expect(rows(db, 'anon', `select 1 from public.transaction_list`)).rejects.toThrow(/permission denied/);
  });

  it('leaves out deleted donations', async () => {
    await as(db, ADMIN, tx => tx.query(`delete from public.donations where id = 'p2'`));
    expect(await rows(db, 'service_role', `select 1 from public.transaction_list where id = 'p2'`)).toEqual([]);
  });

  it('does not lose donations whose campaign was deleted', async () => {
    await as(db, ADMIN, tx => tx.query(`delete from public.campaigns where id = '1002'`));
    const [r] = await rows(db, ADMIN, `select id, campaign_internal from public.transaction_list where id = 'b1'`);
    expect(r).toEqual({ id: 'b1', campaign_internal: null });
  });
});

describe('net follows amount and fee', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); });
  const net = async () => (await db.query<{ net_donation: string }>(`select net_donation from public.donations where id = 'p1'`)).rows[0].net_donation;

  it('updates when either changes', async () => {
    await as(db, ADMIN, tx => tx.query(`update public.donations set fee = 0 where id = 'p1'`));
    expect(await net()).toBe('1000.00');
    await as(db, ADMIN, tx => tx.query(`update public.donations set amount = 500 where id = 'p1'`));
    expect(await net()).toBe('500.00');
  });

  it('respects a net edited at the same time, and ignores other edits', async () => {
    await as(db, ADMIN, tx => tx.query(`update public.donations set fee = 1, net_donation = 123 where id = 'p1'`));
    expect(await net()).toBe('123.00');
    await as(db, ADMIN, tx => tx.query(`update public.donations set notes = 'x' where id = 'p1'`));
    expect(await net()).toBe('123.00');
  });
});

describe('bulk edit', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); });
  const bulk = (user: string, list: string[], patch: object) => rows<{ n: number }>(
    db, user, `select public.bulk_update_donations($1, $2) as n`, [list, JSON.stringify(patch)]);

  it('changes only the fields given, on each record, with its own log entry', async () => {
    expect((await bulk(ADMIN, ['p1', 'p2'], { notes: 'bulk', fee: 0 }))[0].n).toBe(2);
    const r = (await db.query(`select id, notes, fee, amount, net_donation from public.donations where id in ('p1','p2') order by id`)).rows;
    expect(r).toEqual([
      { id: 'p1', notes: 'bulk', fee: '0.00', amount: '1000.00', net_donation: '1000.00' },
      { id: 'p2', notes: 'bulk', fee: '0.00', amount: '250.50', net_donation: '250.50' },
    ]);
    const log = (await db.query<{ record_id: string; user_email: string }>(`select record_id, user_email from public.activity_log where table_name = 'donations' and action = 'update' order by record_id`)).rows;
    expect(log).toEqual([{ record_id: 'p1', user_email: 'office@example.org' }, { record_id: 'p2', user_email: 'office@example.org' }]);
  });

  it('moves a donation between campaigns, taking its money with it', async () => {
    const raised = async (id: string) => (await rows<{ raised: string; fees: string }>(db, ADMIN, `select raised, fees from public.campaign_summary where id = $1`, [id]))[0];
    await bulk(ADMIN, ['p2'], { campaign_id: '1003' });
    expect(await raised('1001')).toEqual({ raised: '1000.00', fees: '29.30' });
    expect(await raised('1003')).toEqual({ raised: '350.50', fees: '10.76' });
  });

  it('can clear a field', async () => {
    await bulk(ADMIN, ['p1'], { donor_id: null });
    expect((await db.query(`select donor_id from public.donations where id = 'p1'`)).rows).toEqual([{ donor_id: null }]);
  });

  it('does all or nothing, and respects closed campaigns', async () => {
    await as(db, ADMIN, tx => tx.query(`update public.campaigns set status = 'closed' where id = '1002'`));
    await expect(bulk(ADMIN, ['p1', 'p2'], { campaign_id: '1002' })).rejects.toThrow(/closed/);
    expect((await db.query(`select campaign_id from public.donations where id in ('p1','p2')`)).rows).toEqual([{ campaign_id: '1001' }, { campaign_id: '1001' }]);
  });

  it('reactivates an archived campaign that money moves to', async () => {
    await as(db, ADMIN, tx => tx.query(`update public.campaigns set status = 'archived' where id = '1002'`));
    await bulk(ADMIN, ['p1'], { campaign_id: '1002' });
    expect((await db.query(`select status from public.campaigns where id = '1002'`)).rows).toEqual([{ status: 'active' }]);
  });

  it('refuses fields outside the list, and non-admins', async () => {
    await expect(bulk(ADMIN, ['p1'], { org_id: 'x' })).rejects.toThrow(/Can't bulk edit org_id/);
    await expect(bulk(ADMIN, ['p1'], { deleted_at: null })).rejects.toThrow(/Can't bulk edit/);
    await expect(bulk(MANAGER_1, ['p1'], { notes: 'x' })).rejects.toThrow(/Only admins/);
    await expect(bulk('anon', ['p1'], { notes: 'x' })).rejects.toThrow(/permission denied/);
  });

  it("can't reach another organization's records", async () => {
    await withOtherOrg(db);
    expect((await rows<{ n: number }>(db, OTHER_ADMIN, `select public.bulk_update_donations(array['p2','v1'], '{"notes":"x"}') as n`))[0].n).toBe(0);
    expect((await rows<{ n: number }>(db, OTHER_ADMIN, `select public.bulk_update_donations(array['p1'], '{"notes":"theirs"}') as n`))[0].n).toBe(1);
    const r = (await db.query(`select notes from public.donations where id = 'p1' order by org_id`)).rows;
    expect(r).toEqual([{ notes: null }, { notes: 'theirs' }]);
  });

  it('voids as a status change, reversing the money', async () => {
    await bulk(ADMIN, ['p1'], { status: 'voided' });
    const [c] = await rows<{ raised: string; fees: string }>(db, ADMIN, `select raised, fees from public.campaign_summary where id = '1001'`);
    expect(c).toEqual({ raised: '250.50', fees: '7.56' });
  });
});

describe('bulk delete', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); });

  it('hides the records, keeps them on file, logs each, and counts them', async () => {
    const [{ n }] = await rows<{ n: number }>(db, ADMIN, `select public.bulk_delete_donations(array['p1','p2','nope']) as n`);
    expect(n).toBe(2);
    expect((await db.query(`select id from public.donations where id in ('p1','p2') and deleted_at is not null`)).rows).toHaveLength(2);
    expect((await db.query(`select 1 from public.activity_log where action = 'soft_delete' and table_name = 'donations'`)).rows).toHaveLength(2);
    const [c] = await rows<{ raised: string }>(db, ADMIN, `select raised from public.campaign_summary where id = '1001'`);
    expect(c.raised).toBe('0');
  });

  it('is admin only and stays inside the organization', async () => {
    await expect(rows(db, MANAGER_1, `select public.bulk_delete_donations(array['p1'])`)).rejects.toThrow(/Only admins/);
    await withOtherOrg(db);
    await as(db, OTHER_ADMIN, tx => tx.query(`select public.bulk_delete_donations(array['p2'])`));
    expect((await db.query(`select deleted_at from public.donations where id = 'p2'`)).rows).toEqual([{ deleted_at: null }]);
  });
});
