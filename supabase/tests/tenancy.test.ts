import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, MANAGER_1, OIZER, PENDING, as, ids, rows, seededDb } from './harness';

const OTHER = '00000000-0000-4000-8000-0000000000bb';
const OTHER_ADMIN = '00000000-0000-0000-0000-0000000000b1';
const BOTH = '00000000-0000-0000-0000-0000000000b2';
const OWNER = '00000000-0000-0000-0000-0000000000cc';

/** A second organization that deliberately reuses Oizer's campaign, source and donor IDs. */
async function withOtherOrg(db: PGlite) {
  await db.exec(`
    insert into public.organizations (id, slug, name) values ('${OTHER}', 'other', 'Other Org');
    insert into public.org_domains (hostname, org_id) values ('other.example.org', '${OTHER}');
    select public.seed_org_settings('${OTHER}');
    insert into auth.users (id, email) values
      ('${OTHER_ADMIN}', 'admin@other.org'), ('${BOTH}', 'both@example.org'), ('${OWNER}', 'owner@example.org');
    insert into public.org_members (org_id, user_id, role) values
      ('${OTHER}', '${OTHER_ADMIN}', 'super_admin'), ('${OTHER}', '${BOTH}', 'manager'), ('${OIZER}', '${BOTH}', 'admin');
    insert into public.platform_owners (user_id) values ('${OWNER}');
    insert into public.managers (org_id, id, first_name) values ('${OTHER}', 'm1', 'Their manager');
    insert into public.donors (org_id, id, first_name, last_name) values ('${OTHER}', 'd1', 'Their', 'Donor');
    insert into public.sources (org_id, id, name) values ('${OTHER}', 's1', 'Their machine');
    insert into public.campaigns (org_id, id, internal_name, manager_id) values ('${OTHER}', '1001', 'Their campaign', 'm1');
    insert into public.donations (org_id, id, campaign_id, donor_id, amount, fee) values
      ('${OTHER}', 'p1', '1001', 'd1', 77.00, 1.00);
    insert into public.user_managers (org_id, user_id, manager_id) values ('${OTHER}', '${BOTH}', 'm1');
  `);
}

const raisedFor = async (db: PGlite, actor: string, org?: string) =>
  rows<{ id: string; raised: string }>(db, actor, `select id, raised from public.campaign_summary order by id`, [], org);

describe('migrating Oizer into the first organization', () => {
  it('moves all existing data and keeps each login’s role', async () => {
    const db = await seededDb();
    for (const t of ['campaigns', 'donations', 'donors', 'expenses', 'transfers', 'pledges', 'tasks', 'managers', 'settings', 'admin_emails']) {
      const r = (await db.query<{ n: number }>(`select count(*)::int as n from public.${t} where org_id is distinct from '${OIZER}'`)).rows[0];
      expect(r.n, t).toBe(0);
    }
    const members = (await db.query(`select user_id, role from public.org_members where org_id = '${OIZER}' order by user_id`)).rows;
    expect(members).toEqual([
      { user_id: '00000000-0000-0000-0000-000000000001', role: 'manager' },
      { user_id: '00000000-0000-0000-0000-000000000002', role: 'manager' },
      { user_id: ADMIN, role: 'super_admin' },
      { user_id: PENDING, role: 'pending' },
    ]);
  });

  it('keeps logging for old entries under Oizer', async () => {
    const db = await seededDb();
    const r = (await db.query<{ n: number }>(`select count(*)::int as n from public.activity_log where org_id = '${OIZER}'`)).rows[0];
    expect(r.n).toBeGreaterThan(0);
  });
});

describe('the wall between organizations', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); await withOtherOrg(db); });

  it('lets two organizations use the same campaign, source and donor IDs', async () => {
    expect(await raisedFor(db, OTHER_ADMIN)).toEqual([{ id: '1001', raised: '77.00' }]);
    expect((await raisedFor(db, ADMIN)).map(r => r.raised)).toEqual(['1250.50', '375.00', '100.00']);
  });

  it('shows an admin nothing from another organization, on any table or view', async () => {
    for (const t of ['managers', 'donors', 'sources', 'campaigns', 'donations', 'settings', 'activity_log', 'org_members', 'organizations', 'admin_emails']) {
      const mine = (await rows<{ n: number }>(db, OTHER_ADMIN, `select count(*)::int as n from public.${t} where ${t === 'organizations' ? 'id' : 'org_id'} = '${OIZER}'`))[0];
      expect(mine.n, t).toBe(0);
    }
    for (const v of ['campaign_summary', 'donor_summary', 'source_summary', 'account_summary', 'manager_summary']) {
      const mine = (await rows<{ n: number }>(db, OTHER_ADMIN, `select count(*)::int as n from public.${v} where org_id = '${OIZER}'`))[0];
      expect(mine.n, v).toBe(0);
    }
  });

  it("ignores a header naming an organization you don't belong to", async () => {
    expect(await rows(db, OTHER_ADMIN, 'select id from public.campaigns', [], OIZER)).toEqual([]);
    expect(await rows(db, OTHER_ADMIN, 'select id from public.donations', [], OIZER)).toEqual([]);
    expect(await rows(db, OTHER_ADMIN, 'select * from public.organizations', [], OIZER)).toEqual([]);
    expect(await rows(db, OTHER_ADMIN, 'select id from public.campaigns', [], 'not-a-uuid')).toEqual([]);
  });

  it('stops writes into another organization', async () => {
    await expect(rows(db, OTHER_ADMIN, `insert into public.donors (org_id, first_name) values ('${OIZER}', 'x')`)).rejects.toThrow(/row-level security/);
    expect(await rows(db, OTHER_ADMIN, `update public.donors set notes = 'x' where org_id = '${OIZER}' returning id`)).toEqual([]);
    expect(await rows(db, OTHER_ADMIN, `delete from public.donors where org_id = '${OIZER}' returning id`)).toEqual([]);
    await expect(rows(db, OTHER_ADMIN, `update public.donors set org_id = '${OIZER}' where id = 'd1'`)).rejects.toThrow(/row-level security/);
  });

  it('puts new records in the right organization without being told', async () => {
    const [r] = await rows<{ org_id: string }>(db, OTHER_ADMIN, `insert into public.donors (first_name) values ('New') returning org_id`);
    expect(r.org_id).toBe(OTHER);
  });

  it("can't link a record to another organization's record, even for the database owner", async () => {
    await db.query(`insert into public.donors (org_id, id, first_name) values ('${OIZER}', 'only-oizer', 'x')`);
    await expect(rows(db, OTHER_ADMIN, `insert into public.donations (campaign_id, donor_id, amount) values ('1001', 'only-oizer', 1)`)).rejects.toThrow(/foreign key/);
    await expect(db.query(`insert into public.donations (org_id, campaign_id, donor_id, amount) values ('${OTHER}', '1001', 'only-oizer', 1)`)).rejects.toThrow(/foreign key/);
  });

  it('soft-deletes and restores only in your own organization', async () => {
    await as(db, OTHER_ADMIN, tx => tx.query(`delete from public.donations where id = 'p1'`));
    const left = (await db.query<{ org_id: string; gone: boolean }>(`select org_id, deleted_at is not null as gone from public.donations where id = 'p1' order by org_id`)).rows;
    expect(left).toEqual([{ org_id: OIZER, gone: false }, { org_id: OTHER, gone: true }]);
    await as(db, OTHER_ADMIN, tx => tx.query(`select public.restore_record('donations', 'p1')`));
    expect((await raisedFor(db, OTHER_ADMIN))[0].raised).toBe('77.00');
  });

  it("keeps each organization's activity log to itself", async () => {
    await as(db, OTHER_ADMIN, tx => tx.query(`update public.donors set notes = 'theirs' where id = 'd1'`));
    await as(db, ADMIN, tx => tx.query(`update public.donors set notes = 'ours' where id = 'd1'`));
    const theirs = await rows<{ user_email: string }>(db, OTHER_ADMIN, `select user_email from public.activity_log where action = 'update' and table_name = 'donors'`);
    const ours = await rows<{ user_email: string }>(db, ADMIN, `select user_email from public.activity_log where action = 'update' and table_name = 'donors'`);
    expect(theirs).toEqual([{ user_email: 'admin@other.org' }]);
    expect(ours).toEqual([{ user_email: 'office@example.org' }]);
  });

  it('keeps settings and balance snapshots per organization', async () => {
    await as(db, OTHER_ADMIN, tx => tx.query(`update public.settings set value = '30' where key = 'inactive_campaign_days'`));
    expect(await rows(db, ADMIN, `select value from public.settings where key = 'inactive_campaign_days'`)).toEqual([{ value: 90 }]);
    expect((await rows<{ n: number }>(db, OTHER_ADMIN, `select public.take_balance_snapshot('x') as n`))[0].n).toBe(1);
    expect((await rows<{ n: number }>(db, ADMIN, `select public.take_balance_snapshot('x') as n`))[0].n).toBe(3);
    expect(await rows(db, ADMIN, `select * from public.balance_drift('x')`)).toEqual([]);
  });

  it("lets an admin see only their organization's people", async () => {
    const seen = await rows<{ email: string }>(db, OTHER_ADMIN, `select email from public.profiles order by email`);
    expect(seen.map(p => p.email)).toEqual(['admin@other.org', 'both@example.org']);
  });

  it("doesn't let admins change an organization's status or another's details", async () => {
    await expect(rows(db, ADMIN, `update public.organizations set status = 'suspended'`)).rejects.toThrow(/permission denied/);
    expect(await rows(db, ADMIN, `update public.organizations set name = 'Renamed' returning id`)).toEqual([{ id: OIZER }]);
    const other = (await db.query<{ name: string }>(`select name from public.organizations where id = '${OTHER}'`)).rows[0];
    expect(other.name).toBe('Other Org');
    expect(await rows(db, MANAGER_1, `update public.organizations set name = 'Hacked' returning id`)).toEqual([]);
  });
});

describe('someone in two organizations', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); await withOtherOrg(db); });

  it('needs the URL to say which organization, and gets that role there', async () => {
    expect(await rows(db, BOTH, 'select id from public.campaigns')).toEqual([]);
    expect(ids(await rows(db, BOTH, 'select id from public.campaigns', [], OIZER))).toEqual(['1001', '1002', '1003']);
    expect(ids(await rows(db, BOTH, 'select id from public.campaigns', [], OTHER))).toEqual(['1001']);
    const access = async (org: string) => (await rows<{ a: { role: string } }>(db, BOTH, `select public.my_access() as a`, [], org))[0].a;
    expect((await access(OIZER)).role).toBe('admin');
    expect((await access(OTHER)).role).toBe('manager');
  });

  it("is limited to their manager role's campaigns in the other organization", async () => {
    expect(await rows(db, BOTH, `insert into public.donors (first_name) values ('x') returning id`, [], OTHER).catch(e => e.message)).toMatch(/row-level security/);
    expect(ids(await rows(db, BOTH, `insert into public.donors (first_name) values ('x') returning 'ok' as id`, [], OIZER))).toEqual(['ok']);
  });

  it('lists only their own organizations', async () => {
    const a = (await rows<{ a: { orgs: { slug: string; role: string }[] } }>(db, BOTH, `select public.my_access() as a`, [], OIZER))[0].a;
    expect(a.orgs.map(o => [o.slug, o.role])).toEqual([['oizer', 'admin'], ['other', 'manager']]);
  });
});

describe('sign-ups and access links', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); await withOtherOrg(db); });
  const memberships = async (email: string) => (await db.query<{ org_id: string; role: string }>(
    `select m.org_id, m.role from public.org_members m join auth.users u on u.id = m.user_id where u.email = $1 order by m.org_id`, [email])).rows;

  it('gives access in each organization that listed the email', async () => {
    await db.exec(`insert into public.admin_emails (org_id, email) values ('${OTHER}', 'new@example.org')`);
    await db.exec(`insert into public.managers (org_id, id, first_name, email) values ('${OIZER}', 'mx', 'New', 'new@example.org')`);
    await db.exec(`insert into auth.users (email) values ('new@example.org')`);
    expect(await memberships('new@example.org')).toEqual([{ org_id: OIZER, role: 'manager' }, { org_id: OTHER, role: 'admin' }]);
    const links = (await db.query(`select manager_id from public.user_managers um join auth.users u on u.id = um.user_id where u.email = 'new@example.org'`)).rows;
    expect(links).toEqual([{ manager_id: 'mx' }]);
  });

  it('adds someone who signed up on an organization’s page as pending there only', async () => {
    await db.exec(`insert into auth.users (email, raw_user_meta_data) values ('walkin@example.org', '{"org_slug":"other"}')`);
    expect(await memberships('walkin@example.org')).toEqual([{ org_id: OTHER, role: 'pending' }]);
  });

  it('leaves a sign-up with no organization with no access', async () => {
    await db.exec(`insert into auth.users (email) values ('stray@example.org')`);
    expect(await memberships('stray@example.org')).toEqual([]);
  });

  it('gives an existing login access as soon as an organization lists them', async () => {
    await as(db, OTHER_ADMIN, tx => tx.query(`insert into public.admin_emails (email) values ('one@example.org')`));
    expect(await memberships('one@example.org')).toEqual([{ org_id: OIZER, role: 'manager' }, { org_id: OTHER, role: 'admin' }]);
  });

  it('links an existing login when a manager record is added for them', async () => {
    await as(db, OTHER_ADMIN, tx => tx.query(`insert into public.managers (id, first_name, email) values ('mz', 'Z', 'nobody@example.org')`));
    expect(await memberships('nobody@example.org')).toEqual([{ org_id: OIZER, role: 'pending' }, { org_id: OTHER, role: 'manager' }]);
    expect(await rows(db, PENDING, 'select id from public.campaigns', [], OTHER)).toEqual([]);
  });
});

describe('a suspended organization', () => {
  it('locks its members out until reinstated, without touching data', async () => {
    const db = await seededDb();
    await withOtherOrg(db);
    await as(db, OWNER, tx => tx.query(`select public.platform_set_org_status('${OTHER}', 'suspended')`));
    expect(await rows(db, OTHER_ADMIN, 'select id from public.campaigns')).toEqual([]);
    expect(await rows(db, OTHER_ADMIN, 'select id from public.campaigns', [], OTHER)).toEqual([]);
    expect(await rows(db, 'anon', `select id from public.resolve_org('other.example.org')`)).toEqual([]);
    expect(ids(await rows(db, ADMIN, 'select id from public.campaigns'))).toEqual(['1001', '1002', '1003']);

    await as(db, OWNER, tx => tx.query(`select public.platform_set_org_status('${OTHER}', 'active')`));
    expect(ids(await rows(db, OTHER_ADMIN, 'select id from public.campaigns'))).toEqual(['1001']);
  });
});

describe('the Platform Owner', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); await withOtherOrg(db); });
  const enter = () => as(db, OWNER, tx => tx.query(`select public.platform_enter_org('${OTHER}', 'support ticket 12')`));

  it('sees counts but no data until they open a session', async () => {
    const list = await rows<{ slug: string; campaign_count: number; donation_count: number }>(db, OWNER, `select slug, campaign_count::int, donation_count::int from public.platform_list_orgs()`);
    expect(list).toEqual([
      { slug: 'oizer', campaign_count: 3, donation_count: 6 },
      { slug: 'other', campaign_count: 1, donation_count: 1 },
    ]);
    expect(await rows(db, OWNER, 'select id from public.campaigns', [], OTHER)).toEqual([]);
  });

  it('gets admin access only to the organization they entered, and it is logged there', async () => {
    await enter();
    expect(ids(await rows(db, OWNER, 'select id from public.campaigns', [], OTHER))).toEqual(['1001']);
    expect(await rows(db, OWNER, 'select id from public.campaigns', [], OIZER)).toEqual([]);

    await as(db, OWNER, tx => tx.query(`update public.donors set notes = 'fixed' where id = 'd1'`), OTHER);
    const log = await rows<{ action: string; user_role: string; user_email: string }>(
      db, OTHER_ADMIN, `select action, user_role, user_email from public.activity_log where user_email = 'owner@example.org' order by id`);
    expect(log).toEqual([
      { action: 'platform_enter', user_role: 'platform_owner', user_email: 'owner@example.org' },
      { action: 'update', user_role: 'platform_owner', user_email: 'owner@example.org' },
    ]);
  });

  it('loses access on exit or when the session expires, and the exit is logged', async () => {
    await enter();
    await as(db, OWNER, tx => tx.query(`select public.platform_exit_org()`));
    expect(await rows(db, OWNER, 'select id from public.campaigns', [], OTHER)).toEqual([]);
    expect(await rows(db, OTHER_ADMIN, `select 1 from public.activity_log where action = 'platform_exit'`)).toHaveLength(1);

    await enter();
    await db.exec(`update public.platform_sessions set expires_at = now() - interval '1 minute' where ended_at is null`);
    expect(await rows(db, OWNER, 'select id from public.campaigns', [], OTHER)).toEqual([]);
  });

  it('can create an organization that starts empty, with its admin ready', async () => {
    const [{ id }] = await rows<{ id: string }>(db, OWNER, `select public.platform_create_org('New Shul', 'new-shul', 'one@example.org', 'pay.newshul.org') as id`);
    const access = (await rows<{ a: { role: string } }>(db, MANAGER_1, `select public.my_access() as a`, [], id))[0].a;
    expect(access.role).toBe('super_admin');
    expect(await rows(db, MANAGER_1, 'select id from public.campaigns', [], id)).toEqual([]);
    expect((await rows(db, MANAGER_1, 'select key from public.settings', [], id)).length).toBe(7);
    expect(ids(await rows(db, MANAGER_1, 'select id from public.sources', [], id))).toEqual(['Manual']);
    expect((await rows<{ slug: string }>(db, 'anon', `select slug from public.resolve_org('pay.newshul.org')`))[0].slug).toBe('new-shul');
    await expect(rows(db, OWNER, `select public.platform_create_org('Dup', 'new-shul', 'x@example.org')`)).rejects.toThrow(/duplicate key/);
  });

  it('is closed to everyone else, including organization admins', async () => {
    for (const q of [`select * from public.platform_list_orgs()`, `select public.platform_enter_org('${OTHER}')`,
                     `select public.platform_create_org('x', 'x', 'x@x.org')`, `select public.platform_set_org_status('${OTHER}', 'suspended')`]) {
      await expect(rows(db, ADMIN, q), q).rejects.toThrow(/Only the Platform Owner/);
      await expect(rows(db, 'anon', q), q).rejects.toThrow(/permission denied/);
    }
  });

  it("can't be granted through a platform_sessions row alone", async () => {
    await expect(rows(db, ADMIN, `insert into public.platform_sessions (user_id, org_id) values ('${ADMIN}', '${OTHER}')`)).rejects.toThrow(/permission denied/);
    await db.exec(`insert into public.platform_sessions (user_id, org_id) values ('${ADMIN}', '${OTHER}')`);
    expect(await rows(db, ADMIN, 'select id from public.campaigns', [], OTHER)).toEqual([]);
  });
});

describe('finding the organization from the URL', () => {
  it('works before sign-in and reveals only branding', async () => {
    const db = await seededDb();
    const [o] = await rows<Record<string, unknown>>(db, 'anon', `select * from public.resolve_org('OIZER.trubase.org')`);
    expect(Object.keys(o).sort()).toEqual(['id', 'logo_url', 'name', 'primary_color', 'slug', 'timezone']);
    expect(o.name).toBe('Oizer Umoshia');
    expect(await rows(db, 'anon', `select * from public.resolve_org('unknown.example.org')`)).toEqual([]);
    expect((await rows<{ slug: string }>(db, 'anon', `select slug from public.resolve_org('localhost', 'oizer')`))[0].slug).toBe('oizer');
  });
});

describe('account lockout', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); await withOtherOrg(db); });
  const EMAIL = 'one@example.org';
  const fail = async (email = EMAIL) => (await rows<{ locked: boolean }>(db, 'service_role', `select public.record_login_attempt($1, false) as locked`, [email]))[0].locked;
  const succeed = () => rows(db, 'service_role', `select public.record_login_attempt($1, true)`, [EMAIL]);
  const locked = async () => (await rows<{ l: boolean }>(db, 'service_role', `select public.login_locked($1) as l`, [EMAIL]))[0].l;

  it('locks on the fifth wrong password in a row, and logs it', async () => {
    for (let i = 0; i < 4; i++) expect(await fail()).toBe(false);
    expect(await locked()).toBe(false);
    expect(await fail()).toBe(true);
    expect(await locked()).toBe(true);
    const log = (await db.query<{ action: string; n: number }>(`select action, count(*)::int as n from public.activity_log where action in ('login_failed','account_locked') group by action order by action`)).rows;
    expect(log).toEqual([{ action: 'account_locked', n: 1 }, { action: 'login_failed', n: 5 }]);
  });

  it('ignores case in the email', async () => {
    for (let i = 0; i < 5; i++) await fail('ONE@Example.org');
    expect(await locked()).toBe(true);
  });

  it('resets the count on a correct password', async () => {
    for (let i = 0; i < 4; i++) await fail();
    await succeed();
    for (let i = 0; i < 4; i++) expect(await fail()).toBe(false);
    expect(await locked()).toBe(false);
  });

  it('ignores emails with no account', async () => {
    for (let i = 0; i < 6; i++) expect(await fail('nobody-here@example.org')).toBe(false);
    expect((await db.query(`select 1 from public.login_attempts`)).rows).toEqual([]);
  });

  it('lets people back in after an hour, with a fresh count', async () => {
    for (let i = 0; i < 5; i++) await fail();
    await db.exec(`update public.login_attempts set locked_until = now() - interval '1 minute'`);
    expect(await locked()).toBe(false);
    expect(await fail()).toBe(false);
    expect((await db.query<{ failed_count: number }>(`select failed_count from public.login_attempts`)).rows[0].failed_count).toBe(1);
  });

  it('is cleared by resetting the password', async () => {
    for (let i = 0; i < 5; i++) await fail();
    await db.query(`update auth.users set encrypted_password = 'new' where id = $1`, [MANAGER_1]);
    expect(await locked()).toBe(false);
  });

  it('can be unlocked by an admin of their organization only', async () => {
    for (let i = 0; i < 5; i++) await fail();
    expect(await rows(db, ADMIN, `select user_id from public.locked_accounts()`)).toEqual([{ user_id: MANAGER_1 }]);
    expect(await rows(db, OTHER_ADMIN, `select user_id from public.locked_accounts()`)).toEqual([]);
    await expect(rows(db, OTHER_ADMIN, `select public.unlock_account('${MANAGER_1}')`)).rejects.toThrow(/Only an admin/);
    await expect(rows(db, MANAGER_1, `select public.unlock_account('${MANAGER_1}')`)).rejects.toThrow(/Only an admin/);
    await as(db, ADMIN, tx => tx.query(`select public.unlock_account('${MANAGER_1}')`));
    expect(await locked()).toBe(false);
  });

  it('keeps attempts and these functions away from the API', async () => {
    await expect(rows(db, ADMIN, `select * from public.login_attempts`)).rejects.toThrow(/permission denied/);
    for (const actor of [ADMIN, 'anon']) {
      await expect(rows(db, actor, `select public.record_login_attempt('${EMAIL}', true)`)).rejects.toThrow(/permission denied/);
      await expect(rows(db, actor, `select public.login_locked('${EMAIL}')`)).rejects.toThrow(/permission denied/);
    }
    await expect(rows(db, 'anon', `select * from public.locked_accounts()`)).rejects.toThrow(/permission denied/);
  });
});
