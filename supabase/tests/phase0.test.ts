import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, MANAGER_1, MANAGER_2, PENDING, as, freshDb, ids, migrate, rows, seed, seededDb } from './harness';

const balances = async (db: PGlite) =>
  (await db.query(`select id, raised, fees, expenses, balance, pending_balance from public.campaign_summary order by id`)).rows;

// Worked out by hand from the seed data.
const EXPECTED = [
  // 1000 + 250.50 raised; fees exclude the voided row; expenses 300.25 + 75 transferred out.
  { id: '1001', raised: '1250.50', fees: '36.86', expenses: '375.25', balance: '838.39', pending_balance: '0' },
  // 300 funded + 75 transferred in; only the funded part counts.
  { id: '1002', raised: '375.00', fees: '25.00', expenses: '0', balance: '350.00', pending_balance: '200.00' },
  { id: '1003', raised: '100.00', fees: '3.20', expenses: '0', balance: '96.80', pending_balance: '0' },
];

describe('migrating existing data', () => {
  it('keeps every campaign balance to the cent', async () => {
    const db = await freshDb();
    const files = readdirSync(join(__dirname, '..', 'migrations')).filter(f => f.endsWith('.sql')).sort();
    const phase0 = files.indexOf('20261101000000_phase0_foundations.sql');
    expect(phase0).toBeGreaterThan(0);
    await migrate(db, files.slice(0, phase0));
    await seed(db);
    const before = await balances(db);
    expect(before).toEqual(EXPECTED);

    await migrate(db, files.slice(phase0));
    expect(await balances(db)).toEqual(before);
  });
});

describe('access', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); });

  it('shows a manager only their own and shared campaigns', async () => {
    expect(ids(await rows(db, MANAGER_1, 'select id from public.campaigns'))).toEqual(['1001', '1003']);
    expect(ids(await rows(db, MANAGER_2, 'select id from public.campaigns'))).toEqual(['1002', '1003']);
  });

  it("hides another manager's donations, expenses, tasks and pledges", async () => {
    expect(ids(await rows(db, MANAGER_2, 'select id from public.donations'))).toEqual(['b1', 'p3']);
    expect(await rows(db, MANAGER_2, 'select id from public.expenses')).toEqual([]);
    expect(ids(await rows(db, MANAGER_2, 'select id from public.tasks'))).toEqual(['k2']);
    expect(await rows(db, MANAGER_2, 'select id from public.pledges')).toEqual([]);
  });

  it('applies the same limits through the summary views', async () => {
    expect(ids(await rows(db, MANAGER_2, 'select id from public.campaign_summary'))).toEqual(['1002', '1003']);
  });

  it('gives pending logins and anonymous visitors nothing', async () => {
    for (const t of ['campaigns', 'donations', 'donors', 'settings']) {
      expect(await rows(db, PENDING, `select 1 from public.${t}`)).toEqual([]);
      expect(await rows(db, 'anon', `select 1 from public.${t}`).catch(() => [])).toEqual([]);
    }
  });

  it('stops a manager from changing money records', async () => {
    await expect(rows(db, MANAGER_1, `insert into public.donations (campaign_id, amount) values ('1001', 5)`)).rejects.toThrow(/row-level security/);
    expect(await rows(db, MANAGER_1, `update public.donations set amount = 1 where id = 'p1' returning id`)).toEqual([]);
    expect(await rows(db, MANAGER_1, `delete from public.donations where id = 'p1' returning id`)).toEqual([]);
    expect(await balances(db)).toEqual(EXPECTED);
  });
});

describe('soft delete', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); });

  it('hides a deleted donation, moves the balance, and keeps the row', async () => {
    await as(db, ADMIN, tx => tx.query(`delete from public.donations where id = 'p2'`));
    expect(ids(await rows(db, ADMIN, `select id from public.donations where id = 'p2'`))).toEqual([]);
    const c = (await rows<{ raised: string; balance: string }>(db, ADMIN, `select raised, balance from public.campaign_summary where id = '1001'`))[0];
    expect(c).toEqual({ raised: '1000.00', balance: '595.45' });

    const kept = (await db.query<{ amount: string; deleted_by: string }>(`select amount, deleted_by from public.donations where id = 'p2'`)).rows[0];
    expect(kept).toEqual({ amount: '250.50', deleted_by: 'office@example.org' });
  });

  it('never hard-deletes, even for the service role', async () => {
    await as(db, 'service_role', tx => tx.query(`delete from public.donations where id = 'p1'`));
    expect((await db.query(`select 1 from public.donations where id = 'p1' and deleted_at is not null`)).rows).toHaveLength(1);
    // Views stay correct even though the service role bypasses row-level security.
    const c = (await rows<{ raised: string }>(db, 'service_role', `select raised from public.campaign_summary where id = '1001'`))[0];
    expect(c.raised).toBe('250.50');
  });

  it('restores a record and its effect on the balance', async () => {
    await as(db, ADMIN, tx => tx.query(`delete from public.donations where id = 'p2'`));
    const r = await rows<{ ok: boolean }>(db, ADMIN, `select public.restore_record('donations', 'p2') as ok`);
    expect(r[0].ok).toBe(true);
    expect(await balances(db)).toEqual(EXPECTED);
  });

  it('only lets admins restore, and only on known tables', async () => {
    await as(db, ADMIN, tx => tx.query(`delete from public.donations where id = 'p2'`));
    await expect(rows(db, MANAGER_1, `select public.restore_record('donations', 'p2')`)).rejects.toThrow(/Only admins/);
    await expect(rows(db, ADMIN, `select public.restore_record('activity_log', '1')`)).rejects.toThrow(/Cannot restore/);
  });

  it('stops a manager from soft-deleting a task they can edit', async () => {
    await expect(rows(db, MANAGER_1, `update public.tasks set deleted_at = now() where id = 'k1'`)).rejects.toThrow(/Only admins/);
    expect(await rows(db, MANAGER_1, `delete from public.tasks where id = 'k1' returning id`)).toEqual([]);
    expect(ids(await rows(db, MANAGER_1, `select id from public.tasks`))).toEqual(['k1']);
  });

  it('takes campaign access away when a manager record is deleted', async () => {
    await as(db, ADMIN, tx => tx.query(`delete from public.managers where id = 'm1'`));
    expect(await rows(db, MANAGER_1, 'select id from public.campaigns')).toEqual([]);
    expect(await rows(db, MANAGER_1, 'select id from public.donations')).toEqual([]);
  });

  it('hides a deleted campaign from its manager and keeps its ID reserved', async () => {
    await as(db, ADMIN, tx => tx.query(`delete from public.campaigns where id = '1001'`));
    expect(ids(await rows(db, MANAGER_1, 'select id from public.campaigns'))).toEqual(['1003']);
    expect(ids(await rows(db, ADMIN, `select id from public.campaign_summary`))).toEqual(['1002', '1003']);
    await expect(rows(db, ADMIN, `insert into public.campaigns (id) values ('1001')`)).rejects.toThrow(/duplicate key/);
  });

  it('does not count a deleted manager as a match for a new sign-up', async () => {
    await as(db, ADMIN, tx => tx.query(`delete from public.managers where id = 'm1'`));
    await db.query(`delete from auth.users where email = 'one@example.org'`);
    await db.query(`insert into auth.users (email) values ('one@example.org')`);
    const members = (await db.query(`select m.role from public.org_members m join auth.users u on u.id = m.user_id where u.email = 'one@example.org'`)).rows;
    expect(members).toEqual([]);
  });
});

describe('activity log', () => {
  let db: PGlite;
  const log = (d: PGlite, where: string) => d.query<Record<string, any>>(`select * from public.activity_log where ${where} order by id`);
  beforeEach(async () => { db = await seededDb(); });

  it('records who changed what, field by field', async () => {
    await as(db, ADMIN, tx => tx.query(`update public.donations set amount = 1100 where id = 'p1'`));
    const [e] = (await log(db, `table_name = 'donations' and record_id = 'p1' and action = 'update'`)).rows;
    expect(e.user_email).toBe('office@example.org');
    expect(e.user_role).toBe('admin');
    expect(e.campaign_id).toBe('1001');
    expect(Object.keys(e.changes)).toEqual(['amount']);
    expect(e.changes.amount).toEqual({ old: 1000.0, new: 1100 });
  });

  it('records inserts, soft deletes and restores', async () => {
    await as(db, ADMIN, async tx => {
      await tx.query(`insert into public.donations (id, campaign_id, amount) values ('n1', '1002', 18)`);
      await tx.query(`delete from public.donations where id = 'n1'`);
      await tx.query(`select public.restore_record('donations', 'n1')`);
    });
    const actions = (await log(db, `record_id = 'n1'`)).rows.map(r => r.action);
    expect(actions).toEqual(['insert', 'soft_delete', 'restore']);
  });

  it('skips updates that change nothing', async () => {
    await as(db, ADMIN, tx => tx.query(`update public.donations set notes = notes where id = 'p1'`));
    expect((await log(db, `record_id = 'p1' and action = 'update'`)).rows).toEqual([]);
  });

  it('reads the IP from the request, and survives a bad header', async () => {
    await as(db, ADMIN, async tx => {
      await tx.query(`select set_config('request.headers', $1, true)`, [JSON.stringify({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1' })]);
      await tx.query(`update public.donors set notes = 'a' where id = 'd1'`);
      await tx.query(`select set_config('request.headers', 'not json', true)`);
      await tx.query(`update public.donors set notes = 'b' where id = 'd1'`);
    });
    expect((await log(db, `record_id = 'd1' and action = 'update'`)).rows.map(r => r.ip)).toEqual(['203.0.113.9', null]);
  });

  it('cannot be changed by anyone, including the database owner', async () => {
    await as(db, ADMIN, tx => tx.query(`update public.donors set notes = 'x' where id = 'd1'`));
    await expect(db.query(`update public.activity_log set user_email = 'x'`)).rejects.toThrow(/append-only/);
    await expect(db.query(`delete from public.activity_log`)).rejects.toThrow(/append-only/);
    await expect(db.query(`truncate public.activity_log`)).rejects.toThrow(/append-only/);
    await expect(rows(db, ADMIN, `delete from public.activity_log`)).rejects.toThrow(/permission denied/);
    await expect(rows(db, ADMIN, `insert into public.activity_log (action) values ('forged')`)).rejects.toThrow(/permission denied/);
    await expect(rows(db, 'service_role', `insert into public.activity_log (action) values ('forged')`)).rejects.toThrow(/permission denied/);
  });

  it('is readable by admins only', async () => {
    expect((await rows(db, ADMIN, `select 1 from public.activity_log limit 1`))).toHaveLength(1);
    expect(await rows(db, MANAGER_1, `select 1 from public.activity_log`)).toEqual([]);
    await expect(rows(db, 'anon', `select 1 from public.activity_log`)).rejects.toThrow(/permission denied/);
  });

  it('logs every sign-in from the auth record, once each', async () => {
    const signIn = (at: string) => db.query(`update auth.users set last_sign_in_at = $1 where id = $2`, [at, MANAGER_1]);
    await signIn('2026-11-01T10:00:00Z');
    await signIn('2026-11-01T11:00:00Z');
    await db.query(`update auth.users set email = 'one@example.org' where id = $1`, [MANAGER_1]);
    const logins = (await log(db, `action = 'login'`)).rows;
    expect(logins).toHaveLength(2);
    expect(logins[0]).toMatchObject({ user_id: MANAGER_1, user_email: 'one@example.org', user_role: 'manager' });
  });

  it('accepts logout and export events under the real signed-in user only', async () => {
    await as(db, MANAGER_1, tx => tx.query(`select public.log_activity('logout')`));
    const [e] = (await log(db, `action = 'logout'`)).rows;
    expect(e.user_id).toBe(MANAGER_1);
    expect(e.user_email).toBe('one@example.org');
    await expect(rows(db, MANAGER_1, `select public.log_activity('login')`)).rejects.toThrow(/Unknown activity/);
    await expect(rows(db, MANAGER_1, `select public.log_activity('update')`)).rejects.toThrow(/Unknown activity/);
    await expect(rows(db, 'anon', `select public.log_activity('logout')`)).rejects.toThrow(/permission denied/);
  });

  it("doesn't let clients call the internal writer directly", async () => {
    await expect(rows(db, ADMIN, `select public.write_activity(null, 'forged', null, null, null, null)`)).rejects.toThrow(/permission denied/);
  });
});

describe('settings', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); });

  it('can be read by active users and changed by admins only', async () => {
    const key = `key = 'duplicate_window_minutes'`;
    expect(await rows(db, MANAGER_1, `select value from public.settings where ${key}`)).toEqual([{ value: 10 }]);
    expect(await rows(db, MANAGER_1, `update public.settings set value = '5' where ${key} returning key`)).toEqual([]);
    await as(db, ADMIN, tx => tx.query(`update public.settings set value = '5' where ${key}`));
    expect(await rows(db, ADMIN, `select value from public.settings where ${key}`)).toEqual([{ value: 5 }]);
    expect((await db.query(`select 1 from public.activity_log where table_name = 'settings' and record_id is null`)).rows).toEqual([]);
  });
});

describe('scheduled jobs', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); });
  const runs = () => db.query<{ job: string; ok: boolean; error: string | null }>(`select job, ok, error from public.job_runs order by id`);

  it('schedules the heartbeat and records each run', async () => {
    const job = (await db.query<{ command: string }>(`select command from cron.job where jobname = 'heartbeat'`)).rows[0];
    await db.exec(job.command);
    expect((await runs()).rows).toEqual([{ job: 'heartbeat', ok: true, error: null }]);
  });

  it('records a failing job instead of losing it', async () => {
    await db.query(`select public.run_job('nope')`);
    expect((await runs()).rows).toEqual([{ job: 'nope', ok: false, error: 'Unknown job nope' }]);
  });

  it('reports jobs as down until a recent heartbeat exists', async () => {
    const check = async () => (await rows<{ h: Record<string, unknown> }>(db, 'service_role', `select public.health_check() as h`))[0].h;
    expect(await check()).toMatchObject({ database: true, jobs: false, last_heartbeat: null });
    await db.query(`select public.run_job('heartbeat')`);
    expect(await check()).toMatchObject({ database: true, jobs: true });
    await db.exec(`update public.job_runs set started_at = now() - interval '3 hours'`);
    expect(await check()).toMatchObject({ database: true, jobs: false });
  });

  it("can't be started over the API, and history is for the Platform Owner only", async () => {
    await expect(rows(db, ADMIN, `select public.run_job('heartbeat')`)).rejects.toThrow(/permission denied/);
    await expect(rows(db, 'anon', `select public.health_check()`)).rejects.toThrow(/permission denied/);
    await expect(rows(db, MANAGER_1, `select public.health_check()`)).rejects.toThrow(/permission denied/);
    await db.query(`select public.run_job('heartbeat')`);
    expect(await rows(db, ADMIN, `select 1 from public.job_runs`)).toEqual([]);
    expect(await rows(db, MANAGER_1, `select 1 from public.job_runs`)).toEqual([]);
    await db.query(`insert into public.platform_owners (user_id) values ($1)`, [ADMIN]);
    expect(await rows(db, ADMIN, `select 1 from public.job_runs`)).toHaveLength(1);
  });
});

describe('balance snapshots', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); });

  it('reports no drift until a number moves, then names the campaign', async () => {
    const taken = await rows<{ n: number }>(db, ADMIN, `select public.take_balance_snapshot('test') as n`);
    expect(taken[0].n).toBe(3);
    expect(await rows(db, ADMIN, `select * from public.balance_drift('test')`)).toEqual([]);

    await as(db, ADMIN, tx => tx.query(`insert into public.donations (campaign_id, amount) values ('1003', 0.01)`));
    const drift = await rows<{ campaign_id: string; snapshot_balance: string; current_balance: string }>(
      db, ADMIN, `select campaign_id, snapshot_balance, current_balance from public.balance_drift('test')`);
    expect(drift).toEqual([{ campaign_id: '1003', snapshot_balance: '96.80', current_balance: '96.81' }]);
  });

  it('is closed to managers', async () => {
    await expect(rows(db, MANAGER_1, `select public.take_balance_snapshot('x')`)).rejects.toThrow(/Only admins/);
    await expect(rows(db, MANAGER_1, `select * from public.balance_drift('x')`)).rejects.toThrow(/Only admins/);
  });
});
