import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, MANAGER_1, OIZER, as, rows, seededDb } from './harness';

// Plaid (sandbox 2026-11-11; production approved for Oizer 2026-11-13): linked items and synced transactions in the database.
const sql = (db: PGlite, q: string, params: unknown[] = [], user = ADMIN) => as(db, user, tx => tx.query(q, params));
const svc = async (db: PGlite, q: string, params: unknown[] = []) => (await rows(db, 'service_role', q, params))[0];
const ACCOUNT = 'testacct';
const line = (id: string, date: string, amount: number, description = 'Sandbox line') => ({ id, date, amount, description, check_number: null });
const apply = (db: PGlite, added: object[], modified: object[] = [], removed: string[] = [], cursor = 'c1') =>
  svc(db, `select * from public.plaid_apply_sync($1, $2, $3, $4, $5, $6)`,
    [OIZER, ACCOUNT, JSON.stringify(added), JSON.stringify(modified), JSON.stringify(removed), cursor]);
const link = (db: PGlite) => svc(db, `select public.plaid_save_item($1, $2, 'item-sandbox-1', 'access-sandbox-test-token', 'First Platypus Bank', 'plaid-acc-1', 'Plaid Checking', '0000', 'office@example.org')`, [OIZER, ACCOUNT]);
const plaidLines = async (db: PGlite) => (await db.query<Record<string, any>>(
  `select bank_ref, posted_date::text as d, amount::text as amount, description, source, match_id from public.bank_lines where account_id = $1 and source = 'plaid' order by bank_ref`, [ACCOUNT])).rows;

describe('Plaid sandbox', () => {
  let base: PGlite;
  let db: PGlite;
  beforeAll(async () => {
    base = await seededDb();
    await base.query(`insert into public.accounts (org_id, id, name) values ($1, $2, 'Test Operating') on conflict do nothing`, [OIZER, ACCOUNT]);
  });
  beforeEach(async () => { db = await base.clone(); });

  it('lets only admins start a link, on their own bank accounts', async () => {
    expect((await rows(db, ADMIN, `select public.plaid_admin_check($1) as org`, [ACCOUNT]))[0].org).toBe(OIZER);
    await expect(rows(db, MANAGER_1, `select public.plaid_admin_check($1)`, [ACCOUNT])).rejects.toThrow();
    await expect(rows(db, ADMIN, `select public.plaid_admin_check('nope')`)).rejects.toThrow(/Bank account not found/);
    // The service-role functions are out of reach from the app.
    await expect(sql(db, `select public.plaid_save_item($1, $2, 'i', 't', null, 'a', null, null, null)`, [OIZER, ACCOUNT])).rejects.toThrow();
    await expect(sql(db, `select * from public.plaid_item_secret($1, $2)`, [OIZER, ACCOUNT])).rejects.toThrow();
  });

  // Production approved for Oizer (Shulim, 2026-11-13): each link records the environment it was made in.
  it('records whether a link was made in the sandbox or in production, and refuses anything else', async () => {
    await link(db);
    expect((await svc(db, `select environment from public.plaid_item_secret($1, $2)`, [OIZER, ACCOUNT])).environment).toBe('sandbox');
    await svc(db, `select public.plaid_save_item($1, $2, 'item-sample-2', 'access-sample-token-2', 'Sample Bank', 'plaid-acc-2', 'Checking', '1234', 'office@example.org', 'production')`, [OIZER, ACCOUNT]);
    expect((await svc(db, `select environment, access_token from public.plaid_item_secret($1, $2)`, [OIZER, ACCOUNT]))).toMatchObject({ environment: 'production', access_token: 'access-sample-token-2' });
    expect((await rows(db, ADMIN, `select environment from public.plaid_status()`))[0].environment).toBe('production');
    await expect(svc(db, `select public.plaid_save_item($1, $2, 'i', 't', null, 'a', null, null, null, 'development')`, [OIZER, ACCOUNT])).rejects.toThrow(/Unknown Plaid environment/);
  });

  it('keeps the access token encrypted and shows admins only the link details', async () => {
    await link(db);
    const [raw] = (await db.query<Record<string, any>>(`select encode(access_token, 'escape') as t, environment from public.plaid_items`)).rows;
    expect(raw.t).not.toContain('access-sandbox-test-token');
    expect(raw.environment).toBe('sandbox');
    expect((await svc(db, `select access_token from public.plaid_item_secret($1, $2)`, [OIZER, ACCOUNT])).access_token).toBe('access-sandbox-test-token');
    const [s] = await rows(db, ADMIN, `select * from public.plaid_status()`);
    expect(s).toMatchObject({ account_id: ACCOUNT, institution_name: 'First Platypus Bank', account_mask: '0000', environment: 'sandbox' });
    expect(JSON.stringify(s)).not.toContain('access-sandbox');
    expect(await rows(db, MANAGER_1, `select * from public.plaid_status()`)).toEqual([]);
    await expect(sql(db, `select * from public.plaid_items`)).rejects.toThrow();
  });

  it('brings synced transactions in as bank lines once, updates and removes unmatched ones, and moves the cursor', async () => {
    await expect(apply(db, [line('t1', '2026-11-02', -25.5)])).rejects.toThrow(/isn't linked/);
    await link(db);
    expect(await apply(db, [line('t1', '2026-11-02', -25.5, 'Uber'), line('t2', '2026-11-03', 1000, 'Deposit'), line('t0', '2026-11-03', 0)]))
      .toEqual({ added: 2, updated: 0, removed: 0 });
    // The same page again adds nothing.
    expect(await apply(db, [line('t1', '2026-11-02', -25.5, 'Uber')], [], [], 'c2')).toEqual({ added: 0, updated: 0, removed: 0 });
    expect(await plaidLines(db)).toEqual([
      { bank_ref: 't1', d: '2026-11-02', amount: '-25.50', description: 'Uber', source: 'plaid', match_id: null },
      { bank_ref: 't2', d: '2026-11-03', amount: '1000.00', description: 'Deposit', source: 'plaid', match_id: null },
    ]);
    expect(await apply(db, [], [line('t1', '2026-11-02', -26, 'Uber Eats')], ['t2'], 'c3')).toEqual({ added: 0, updated: 1, removed: 1 });
    expect(await plaidLines(db)).toEqual([{ bank_ref: 't1', d: '2026-11-02', amount: '-26.00', description: 'Uber Eats', source: 'plaid', match_id: null }]);
    expect((await svc(db, `select cursor from public.plaid_item_secret($1, $2)`, [OIZER, ACCOUNT])).cursor).toBe('c3');
    expect((await rows(db, ADMIN, `select last_synced_at is not null as synced from public.plaid_status()`))[0].synced).toBe(true);
  });

  it('forgets the link on disconnect and keeps the lines already brought in', async () => {
    await link(db);
    await apply(db, [line('t1', '2026-11-02', -25.5)]);
    await svc(db, `select public.plaid_forget($1, $2)`, [OIZER, ACCOUNT]);
    expect(await rows(db, ADMIN, `select * from public.plaid_status()`)).toEqual([]);
    expect((await plaidLines(db)).length).toBe(1);
  });
});
