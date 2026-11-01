import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, MANAGER_1, MANAGER_2, OIZER, PENDING, as, ids, rows, seededDb } from './harness';

const ADMIN_2 = '00000000-0000-0000-0000-00000000000b';
const GUEST = '00000000-0000-0000-0000-00000000000c';

async function withPeople(db: PGlite) {
  await db.exec(`
    insert into auth.users (id, email) values ('${ADMIN_2}', 'second@example.org'), ('${GUEST}', 'guest@example.org');
    insert into public.org_members (org_id, user_id, role) values ('${OIZER}', '${ADMIN_2}', 'admin');
    insert into public.campaign_guests (org_id, campaign_id, email) values ('${OIZER}', '1001', 'guest@example.org');
  `);
}

const roleOf = async (db: PGlite, user: string) =>
  (await db.query<{ role: string }>(`select role from public.org_members where user_id = $1 and org_id = '${OIZER}'`, [user])).rows[0]?.role;

const raised = async (db: PGlite, id: string) =>
  (await rows<{ raised: string; fees: string; balance: string }>(db, ADMIN, `select raised, fees, balance from public.campaign_summary where id = $1`, [id]))[0];

describe('moving to the new model', () => {
  it('gives each old donation type a status and keeps only two kinds', async () => {
    const db = await seededDb();
    const r = (await db.query(`select id, type, status from public.donations where id in ('p1','b1','c1','v1') order by id`)).rows;
    expect(r).toEqual([
      { id: 'b1', type: 'Batch', status: 'completed' },
      { id: 'c1', type: 'Payment', status: 'collect' },
      { id: 'p1', type: 'Payment', status: 'completed' },
      { id: 'v1', type: 'Payment', status: 'voided' },
    ]);
  });

  it('adds no log entries and leaves Last Update alone for donations', async () => {
    const db = await seededDb();
    const n = (await db.query<{ n: number }>(`select count(*)::int n from public.activity_log where table_name = 'donations' and action = 'update'`)).rows[0];
    expect(n.n).toBe(0);
    const same = (await db.query<{ n: number }>(`select count(*)::int n from public.donations where updated_at <> created_at`)).rows[0];
    expect(same.n).toBe(0);
  });

  it('makes the existing owner the Super Admin and keeps campaign names', async () => {
    const db = await seededDb();
    expect(await roleOf(db, ADMIN)).toBe('super_admin');
    expect(await roleOf(db, MANAGER_1)).toBe('manager');
    const c = (await db.query(`select internal_name, external_name, status from public.campaigns where id = '1001'`)).rows[0];
    expect(c).toEqual({ internal_name: 'First campaign', external_name: 'First campaign', status: 'active' });
  });
});

describe('what counts as money', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); });
  const add = (status: string, fee = 3) => as(db, ADMIN, tx => tx.query(
    `insert into public.donations (campaign_id, amount, fee, status) values ('1003', 100, ${fee}, '${status}')`));

  it('counts only completed gifts toward raised', async () => {
    for (const s of ['pending', 'collect', 'voided', 'refunded', 'returned', 'failed']) await add(s);
    expect((await raised(db, '1003')).raised).toBe('100.00');
    await add('completed');
    expect((await raised(db, '1003')).raised).toBe('200.00');
  });

  it('keeps the fee spent on a refund, but not on a void', async () => {
    const before = await raised(db, '1003');
    await add('voided');
    await add('pending');
    await add('failed');
    expect(await raised(db, '1003')).toEqual(before);
    await add('refunded');
    expect((await raised(db, '1003')).balance).toBe('93.80');
  });

  it('leaves voided and refunded gifts out of donor totals', async () => {
    const total = async () => (await rows<{ total_given: string }>(db, ADMIN, `select total_given from public.donor_summary where id = 'd2'`))[0].total_given;
    const before = await total();
    await as(db, ADMIN, tx => tx.query(`update public.donations set status = 'refunded' where id = 'p3'`));
    expect(Number(await total())).toBe(Number(before) - 100);
  });

  it('rejects unknown statuses and the old types', async () => {
    await expect(add('lost')).rejects.toThrow(/check constraint/);
    await expect(as(db, ADMIN, tx => tx.query(`insert into public.donations (campaign_id, amount, type) values ('1003', 1, 'Voided')`))).rejects.toThrow(/check constraint/);
  });
});

describe('campaign IDs and statuses', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); });
  const status = async (id: string) => (await db.query<{ status: string; archived_at: unknown; closed_at: unknown }>(
    `select status, archived_at, closed_at from public.campaigns where id = $1`, [id])).rows[0];
  const setStatus = (id: string, s: string, user = ADMIN) => as(db, user, tx => tx.query(`update public.campaigns set status = '${s}' where id = '${id}'`));

  it('numbers new campaigns after the highest, and never reuses a number', async () => {
    const create = async () => (await rows<{ id: string }>(db, ADMIN, `insert into public.campaigns (internal_name) values ('New') returning id`))[0].id;
    expect(await create()).toBe('1004');
    await as(db, ADMIN, tx => tx.query(`delete from public.campaigns where id = '1004'`));
    expect(await create()).toBe('1005');
    await as(db, ADMIN, tx => tx.query(`insert into public.campaigns (id, internal_name) values ('ABC', 'Text id'), ('20000', 'Imported')`));
    expect(await create()).toBe('20001');
  });

  it('starts a new organization at 1000', async () => {
    await db.query(`insert into public.organizations (id, slug, name) values ('00000000-0000-4000-8000-0000000000dd', 'n', 'N')`);
    const r = await db.query<{ id: string }>(`insert into public.campaigns (org_id, internal_name) values ('00000000-0000-4000-8000-0000000000dd', 'x') returning id`);
    expect(r.rows[0].id).toBe('1000');
  });

  it('uses the internal name as the external name when none is given', async () => {
    const [r] = await rows<{ external_name: string }>(db, ADMIN, `insert into public.campaigns (internal_name) values ('Only') returning external_name`);
    expect(r.external_name).toBe('Only');
    await expect(rows(db, ADMIN, `insert into public.campaigns (external_name) values ('No internal')`)).rejects.toThrow(/null value/);
  });

  it("doesn't let an ID change", async () => {
    await expect(setStatus('1001', 'active').then(() => as(db, ADMIN, tx => tx.query(`update public.campaigns set id = '9' where id = '1001'`)))).rejects.toThrow(/permanent/);
  });

  it('stamps archive and close dates from the status', async () => {
    await setStatus('1001', 'archived');
    expect((await status('1001')).archived_at).not.toBeNull();
    await setStatus('1001', 'active');
    expect((await status('1001')).archived_at).toBeNull();
    await setStatus('1001', 'closed');
    expect((await status('1001')).closed_at).not.toBeNull();
  });

  it('reactivates an archived campaign when money or a pledge arrives', async () => {
    await setStatus('1001', 'archived');
    await as(db, ADMIN, tx => tx.query(`insert into public.donations (campaign_id, amount) values ('1001', 5)`));
    expect((await status('1001')).status).toBe('active');
    await setStatus('1001', 'archived');
    await as(db, ADMIN, tx => tx.query(`insert into public.pledges (campaign_id, amount) values ('1001', 5)`));
    expect((await status('1001')).status).toBe('active');
  });

  it("doesn't reactivate for a failed gift or an expense", async () => {
    await setStatus('1001', 'archived');
    await as(db, ADMIN, tx => tx.query(`insert into public.donations (campaign_id, amount, status) values ('1001', 5, 'failed')`));
    await as(db, ADMIN, tx => tx.query(`insert into public.expenses (campaign_id, amount) values ('1001', 5)`));
    expect((await status('1001')).status).toBe('archived');
  });

  it('refuses new activity on a closed campaign but allows edits to what is there', async () => {
    await setStatus('1001', 'closed');
    for (const q of [`insert into public.donations (campaign_id, amount) values ('1001', 5)`,
                     `insert into public.pledges (campaign_id, amount) values ('1001', 5)`,
                     `insert into public.expenses (campaign_id, amount) values ('1001', 5)`,
                     `update public.donations set campaign_id = '1001' where id = 'p3'`]) {
      await expect(as(db, ADMIN, tx => tx.query(q)), q).rejects.toThrow(/closed/);
    }
    await as(db, ADMIN, tx => tx.query(`update public.donations set notes = 'corrected' where id = 'p1'`));
  });

  it('refuses transfers touching archived or closed campaigns', async () => {
    await setStatus('1001', 'archived');
    await expect(as(db, ADMIN, tx => tx.query(`insert into public.transfers (amount, from_campaign_id, to_campaign_id) values (1, '1001', '1002')`))).rejects.toThrow(/archived or closed/);
    await setStatus('1002', 'closed');
    await expect(as(db, ADMIN, tx => tx.query(`insert into public.transfers (amount, from_campaign_id, to_campaign_id) values (1, '1003', '1002')`))).rejects.toThrow(/archived or closed/);
  });

  it('only lets the Super Admin reopen a closed campaign, unless delegated', async () => {
    await withPeople(db);
    await setStatus('1001', 'closed', ADMIN_2);
    await expect(setStatus('1001', 'active', ADMIN_2)).rejects.toThrow(/Only the Super Admin/);
    await as(db, ADMIN, tx => tx.query(`select public.set_delegation('${ADMIN_2}', 'reopen_campaigns', true)`));
    await setStatus('1001', 'active', ADMIN_2);
    expect((await status('1001')).status).toBe('active');
  });

  it('logs status changes, including automatic ones', async () => {
    await setStatus('1001', 'archived');
    await as(db, ADMIN, tx => tx.query(`insert into public.donations (campaign_id, amount) values ('1001', 5)`));
    const changes = (await db.query<{ changes: { status: { new: string } } }>(
      `select changes from public.activity_log where table_name = 'campaigns' and record_id = '1001' and action = 'update' order by id`)).rows;
    expect(changes.map(c => c.changes.status.new)).toEqual(['archived', 'active']);
  });
});

describe('Super Admin and admins', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); await withPeople(db); });
  const setRole = (actor: string, user: string, role: string) => as(db, actor, tx => tx.query(`update public.org_members set role = '${role}' where user_id = '${user}'`));

  it('allows only one Super Admin per organization', async () => {
    await expect(db.query(`update public.org_members set role = 'super_admin' where user_id = '${ADMIN_2}'`)).rejects.toThrow(/org_members_one_super_admin/);
  });

  it('lets the Super Admin manage admins, and a regular admin manage only other people', async () => {
    await setRole(ADMIN, PENDING, 'admin');
    expect(await roleOf(db, PENDING)).toBe('admin');
    await expect(setRole(ADMIN_2, PENDING, 'manager')).rejects.toThrow(/Only the Super Admin/);
    await expect(setRole(ADMIN_2, MANAGER_1, 'admin')).rejects.toThrow(/Only the Super Admin/);
    await setRole(ADMIN_2, MANAGER_1, 'pending');
    expect(await roleOf(db, MANAGER_1)).toBe('pending');
  });

  it('protects the Super Admin from regular admins and from accidental demotion', async () => {
    await expect(setRole(ADMIN_2, ADMIN, 'admin')).rejects.toThrow(/Only the Super Admin/);
    await expect(as(db, ADMIN_2, tx => tx.query(`delete from public.org_members where user_id = '${ADMIN}'`))).rejects.toThrow(/Only the Super Admin/);
    await expect(setRole(ADMIN, ADMIN, 'admin')).rejects.toThrow(/transferring/);
  });

  it('can transfer the role, only by the Super Admin', async () => {
    await expect(as(db, ADMIN_2, tx => tx.query(`select public.transfer_super_admin('${ADMIN_2}')`))).rejects.toThrow(/Only the Super Admin/);
    await as(db, ADMIN, tx => tx.query(`select public.transfer_super_admin('${ADMIN_2}')`));
    expect(await roleOf(db, ADMIN_2)).toBe('super_admin');
    expect(await roleOf(db, ADMIN)).toBe('admin');
    await expect(setRole(ADMIN_2, ADMIN_2, 'admin')).rejects.toThrow(/transferring/);
  });

  it('delegates specific powers, shown in access, and takes them back', async () => {
    const perms = async () => (await rows<{ a: { permissions: string[] } }>(db, ADMIN_2, `select public.my_access() as a`))[0].a.permissions;
    expect(await perms()).toEqual([]);
    await expect(setRole(ADMIN_2, PENDING, 'admin')).rejects.toThrow(/Only the Super Admin/);
    await as(db, ADMIN, tx => tx.query(`select public.set_delegation('${ADMIN_2}', 'manage_admins', true)`));
    expect(await perms()).toEqual(['manage_admins']);
    await setRole(ADMIN_2, PENDING, 'admin');
    await as(db, ADMIN, tx => tx.query(`select public.set_delegation('${ADMIN_2}', 'manage_admins', false)`));
    expect(await perms()).toEqual([]);
    const log = (await db.query(`select action from public.activity_log where table_name = 'admin_delegations' order by id`)).rows;
    expect(log).toEqual([{ action: 'insert' }, { action: 'delete' }]);
  });

  it('keeps delegation itself to the Super Admin, and only for admins', async () => {
    await as(db, ADMIN, tx => tx.query(`select public.set_delegation('${ADMIN_2}', 'manage_admins', true)`));
    await expect(as(db, ADMIN_2, tx => tx.query(`select public.set_delegation('${ADMIN_2}', 'configure_fees', true)`))).rejects.toThrow(/Only the Super Admin/);
    await expect(as(db, ADMIN, tx => tx.query(`select public.set_delegation('${MANAGER_1}', 'configure_fees', true)`))).rejects.toThrow(/only be delegated/);
    await expect(rows(db, ADMIN, `insert into public.admin_delegations (user_id, permission) values ('${ADMIN_2}', 'run_imports')`)).rejects.toThrow(/permission denied/);
  });

  it('needs admin authority to add an admin email', async () => {
    await expect(rows(db, ADMIN_2, `insert into public.admin_emails (email) values ('x@example.org')`)).rejects.toThrow(/row-level security/);
    await as(db, ADMIN, tx => tx.query(`insert into public.admin_emails (email) values ('one@example.org')`));
    expect(await roleOf(db, MANAGER_1)).toBe('admin');
  });

  it('makes the first admin of a new organization its Super Admin, and the next a regular admin', async () => {
    await db.query(`insert into public.platform_owners (user_id) values ('${ADMIN}')`);
    const [{ id }] = await rows<{ id: string }>(db, ADMIN, `select public.platform_create_org('Shul', 'shul', 'one@example.org') as id`);
    await db.query(`insert into public.admin_emails (org_id, email) values ('${id}', 'two@example.org')`);
    const m = (await db.query<{ user_id: string; role: string }>(`select user_id, role from public.org_members where org_id = '${id}' order by user_id`)).rows;
    expect(m).toEqual([{ user_id: MANAGER_1, role: 'super_admin' }, { user_id: MANAGER_2, role: 'admin' }]);
  });
});

describe('suspending and deactivating', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); await withPeople(db); });
  const setStatus = (status: string, actor = ADMIN_2) => as(db, actor, tx => tx.query(`select public.set_fundraiser_status('m1', '${status}', 'test')`));

  it('cuts a suspended fundraiser off at once, keeps the campaign running, and restores them', async () => {
    expect(ids(await rows(db, MANAGER_1, 'select id from public.campaigns'))).toEqual(['1001', '1003']);
    await setStatus('suspended');
    expect(await rows(db, MANAGER_1, 'select id from public.campaigns')).toEqual([]);
    expect(await rows(db, MANAGER_1, 'select id from public.donations')).toEqual([]);
    const access = (await rows<{ a: { role: string | null; status: string } }>(db, MANAGER_1, `select public.my_access() as a`))[0].a;
    expect(access).toMatchObject({ role: null, status: 'suspended' });

    const c = (await rows<{ manager_id: string; status: string }>(db, ADMIN, `select manager_id, status from public.campaigns where id = '1001'`))[0];
    expect(c).toEqual({ manager_id: 'm1', status: 'active' });
    await as(db, ADMIN, tx => tx.query(`insert into public.donations (campaign_id, amount) values ('1001', 5)`));

    await setStatus('active');
    expect(ids(await rows(db, MANAGER_1, 'select id from public.campaigns'))).toEqual(['1001', '1003']);
  });

  it('records who did it and why, and logs it', async () => {
    await setStatus('deactivated');
    const m = (await db.query(`select status, status_reason, status_by from public.managers where id = 'm1'`)).rows[0];
    expect(m).toEqual({ status: 'deactivated', status_reason: 'test', status_by: 'second@example.org' });
    expect((await db.query(`select 1 from public.activity_log where table_name = 'managers' and record_id = 'm1' and action = 'update'`)).rows).toHaveLength(1);
  });

  it('is admin only', async () => {
    await expect(setStatus('suspended', MANAGER_2)).rejects.toThrow(/Only admins/);
    await expect(as(db, MANAGER_2, tx => tx.query(`select public.set_member_status('${MANAGER_1}', 'suspended')`))).rejects.toThrow(/Only admins/);
  });

  it('keeps admin accounts to the Super Admin, and nobody suspends themselves', async () => {
    await expect(as(db, ADMIN_2, tx => tx.query(`select public.set_member_status('${ADMIN}', 'suspended')`))).rejects.toThrow(/Only the Super Admin/);
    await expect(as(db, ADMIN, tx => tx.query(`select public.set_member_status('${ADMIN}', 'suspended')`))).rejects.toThrow(/own status/);
    await as(db, ADMIN, tx => tx.query(`select public.set_member_status('${ADMIN_2}', 'suspended')`));
    expect(await rows(db, ADMIN_2, 'select id from public.campaigns')).toEqual([]);
  });

  it('records the last sign-in on the membership without a separate edit entry', async () => {
    await db.query(`update auth.users set last_sign_in_at = '2026-11-02T10:00:00Z' where id = '${MANAGER_1}'`);
    const m = (await db.query<{ last_login_at: Date }>(`select last_login_at from public.org_members where user_id = '${MANAGER_1}'`)).rows[0];
    expect(m.last_login_at.toISOString()).toBe('2026-11-02T10:00:00.000Z');
    expect((await db.query(`select 1 from public.activity_log where table_name = 'org_members' and record_id = '${MANAGER_1}' and action = 'update'`)).rows).toEqual([]);
  });
});

describe('permission overrides', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); await withPeople(db); });
  const has = async (user: string, campaign: string | null) => (await rows<{ h: boolean }>(
    db, user, `select public.has_override('enter_manual_payments', $1) as h`, [campaign]))[0].h;

  it('is per fundraiser: two on one campaign can differ', async () => {
    await as(db, ADMIN, tx => tx.query(`select public.grant_override('m1', 'enter_manual_payments')`));
    expect(await has(MANAGER_1, '1003')).toBe(true);
    expect(await has(MANAGER_2, '1003')).toBe(false);
  });

  it('can be limited to specific campaigns', async () => {
    await as(db, ADMIN, tx => tx.query(`select public.grant_override('m1', 'enter_manual_payments', array['1001'])`));
    expect(await has(MANAGER_1, '1001')).toBe(true);
    expect(await has(MANAGER_1, '1003')).toBe(false);
  });

  it('can be revoked by any admin, keeps its history, and is logged', async () => {
    await as(db, ADMIN, tx => tx.query(`select public.grant_override('m1', 'enter_manual_payments')`));
    await as(db, ADMIN_2, tx => tx.query(`select public.revoke_override('m1', 'enter_manual_payments')`));
    expect(await has(MANAGER_1, '1001')).toBe(false);
    const r = (await db.query(`select granted_by, revoked_by from public.fundraiser_overrides`)).rows;
    expect(r).toEqual([{ granted_by: 'office@example.org', revoked_by: 'second@example.org' }]);
    expect((await db.query(`select action from public.activity_log where table_name = 'fundraiser_overrides' order by id`)).rows).toEqual([{ action: 'insert' }, { action: 'update' }]);
  });

  it('is granted only by the Super Admin or a delegate', async () => {
    const grant = () => as(db, ADMIN_2, tx => tx.query(`select public.grant_override('m1', 'bulk_receipts')`));
    await expect(grant()).rejects.toThrow(/Only the Super Admin/);
    await as(db, ADMIN, tx => tx.query(`select public.set_delegation('${ADMIN_2}', 'grant_overrides', true)`));
    await grant();
    await expect(rows(db, MANAGER_1, `insert into public.fundraiser_overrides (manager_id, permission) values ('m1', 'bulk_receipts')`)).rejects.toThrow(/permission denied/);
    await expect(as(db, MANAGER_1, tx => tx.query(`select public.revoke_override('m1', 'bulk_receipts')`))).rejects.toThrow(/Only admins/);
  });

  it("lets a fundraiser see their own overrides, not someone else's", async () => {
    await as(db, ADMIN, tx => tx.query(`select public.grant_override('m1', 'bulk_receipts')`));
    expect(await rows(db, MANAGER_1, `select permission from public.fundraiser_overrides`)).toEqual([{ permission: 'bulk_receipts' }]);
    expect(await rows(db, MANAGER_2, `select permission from public.fundraiser_overrides`)).toEqual([]);
  });
});

describe('primary and secondary fundraisers', () => {
  it('tells them apart on a campaign', async () => {
    const db = await seededDb();
    const primary = async (user: string, c: string) => (await rows<{ p: boolean }>(db, user, `select public.is_primary_on($1) as p`, [c]))[0].p;
    expect(await primary(MANAGER_2, '1003')).toBe(true);
    expect(await primary(MANAGER_1, '1003')).toBe(false);
    expect(await primary(MANAGER_1, '1002')).toBe(false);
  });
});

describe('Community Guests', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); await withPeople(db); });

  it('become a guest when they sign up with a listed email', async () => {
    expect(await roleOf(db, GUEST)).toBe('guest');
    await db.exec(`insert into public.campaign_guests (org_id, campaign_id, email) values ('${OIZER}', '1002', 'later@example.org');
                   insert into auth.users (email) values ('later@example.org')`);
    const r = (await db.query(`select m.role from public.org_members m join auth.users u on u.id = m.user_id where u.email = 'later@example.org'`)).rows;
    expect(r).toEqual([{ role: 'guest' }]);
  });

  it('see only their campaign, and only donor, amount, method and date', async () => {
    const list = await rows(db, GUEST, `select id, name, status, raised, balance from public.guest_campaigns()`);
    expect(list).toEqual([{ id: '1001', name: 'First campaign', status: 'active', raised: '1250.50', balance: '838.39' }]);
    const feed = await rows<Record<string, unknown>>(db, GUEST, `select * from public.guest_donations('1001') order by amount`);
    expect(feed.map(f => [f.donor, f.amount])).toEqual([['Donor Two', '250.50'], ['Donor One', '1000.00']]);
    expect(Object.keys(feed[0]).sort()).toEqual(['amount', 'created_at', 'donor', 'payment_method']);
    expect(await rows(db, GUEST, `select * from public.guest_donations('1002')`)).toEqual([]);
  });

  it('have no access to any table', async () => {
    for (const t of ['campaigns', 'donations', 'donors', 'expenses', 'transfers', 'pledges', 'tasks', 'managers', 'campaign_summary', 'settings', 'activity_log']) {
      expect(await rows(db, GUEST, `select 1 from public.${t}`), t).toEqual([]);
    }
    await expect(rows(db, GUEST, `insert into public.tasks (campaign_id, title) values ('1001', 'x')`)).rejects.toThrow(/row-level security/);
  });

  it('lose access immediately when removed', async () => {
    await as(db, ADMIN_2, tx => tx.query(`delete from public.campaign_guests where email = 'guest@example.org'`));
    expect(await rows(db, GUEST, `select * from public.guest_campaigns()`)).toEqual([]);
    expect(await rows(db, GUEST, `select * from public.guest_donations('1001')`)).toEqual([]);
  });

  it('are managed by admins only', async () => {
    await expect(rows(db, MANAGER_1, `insert into public.campaign_guests (campaign_id, email) values ('1001', 'x@example.org')`)).rejects.toThrow(/row-level security/);
    await as(db, ADMIN_2, tx => tx.query(`insert into public.campaign_guests (campaign_id, email) values ('1002', 'guest@example.org')`));
    expect((await rows(db, GUEST, `select id from public.guest_campaigns()`)).length).toBe(2);
  });
});
