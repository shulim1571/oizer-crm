import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, MANAGER_1, MANAGER_2, as, rows, seededDb } from './harness';

const summary = async (db: PGlite, id: string, user = ADMIN) =>
  (await rows<Record<string, any>>(db, user, `select * from public.campaign_summary where id = $1`, [id]))[0];
const sql = (db: PGlite, q: string, params: unknown[] = [], user = ADMIN) => as(db, user, tx => tx.query(q, params));
const addSub = async (db: PGlite, parent: string, name: string, mode = 'shared', manager: string | null = null, user = ADMIN) =>
  (await rows<{ id: string }>(db, user, `select public.add_sub_campaign($1, $2, $3, null, $4) as id`, [parent, name, mode, manager]))[0].id;
const give = async (db: PGlite, campaign: string, amount: number, fee = 0) => {
  const [r] = await rows<{ id: string }>(db, ADMIN,
    `insert into public.donations (campaign_id, amount, fee, payment_method, type, status) values ($1, $2, $3, 'Cash', 'Payment', 'completed') returning id`, [campaign, amount, fee]);
  return r.id;
};
const n = (v: unknown) => Number(v);

describe('sub-campaigns', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); });

  it('leave campaigns without any exactly as they were', async () => {
    const c = await summary(db, '1001');
    expect(c).toMatchObject({ balance_mode: 'independent', parent_campaign_id: null, pool_id: null });
    expect(n(c.sub_count)).toBe(0);
    expect(n(c.combined_raised)).toBe(n(c.raised));
    expect(n(c.balance)).toBe(n(c.own_balance));
  });

  it('get a number and a page address of their own, unique within the parent', async () => {
    const a = await addSub(db, '1003', 'Table 12 — Goldstein Family');
    const b = await addSub(db, '1003', 'Table 12: Goldstein Family');
    expect(a).not.toBe('1003');
    const [ra, rb] = await Promise.all([summary(db, a), summary(db, b)]);
    expect(ra).toMatchObject({ parent_campaign_id: '1003', sub_slug: 'table-12-goldstein-family', status: 'active' });
    expect(rb.sub_slug).toBe('table-12-goldstein-family-2');
    await expect(addSub(db, '1003', 'table 12 — goldstein family')).rejects.toThrow(/already has/);
    expect(n((await summary(db, '1003')).sub_count)).toBe(2);
  });

  it('shared: money counts in the parent, the sub only tracks what it raised', async () => {
    const before = await summary(db, '1003');
    const sub = await addSub(db, '1003', 'Table 1');
    await give(db, sub, 500, 25);
    const s = await summary(db, sub);
    expect(n(s.balance)).toBe(0);
    expect(n(s.raised)).toBe(500);
    expect(s.pool_id).toBe('1003');
    const p = await summary(db, '1003');
    expect(n(p.balance)).toBe(n(before.balance) + 475);
    expect(n(p.raised)).toBe(n(before.raised));
    expect(n(p.combined_raised)).toBe(n(before.raised) + 500);
    expect(n(p.combined_fees)).toBe(n(before.fees) + 25);
  });

  it('shared: nesting reaches the nearest level with a balance', async () => {
    const before = n((await summary(db, '1003')).balance);
    const mid = await addSub(db, '1003', 'Division');
    const leaf = await addSub(db, mid, 'Table');
    await give(db, leaf, 100);
    expect(n((await summary(db, leaf)).balance)).toBe(0);
    expect(n((await summary(db, mid)).balance)).toBe(0);
    expect(n((await summary(db, '1003')).balance)).toBe(before + 100);

    const ind = await addSub(db, '1003', 'Independent', 'independent');
    const under = await addSub(db, ind, 'Under it');
    await give(db, under, 40);
    expect(n((await summary(db, ind)).balance)).toBe(40);
    expect(n((await summary(db, '1003')).balance)).toBe(before + 100);
  });

  it('independent: its balance stands alone, even negative, and takes transfers', async () => {
    const before = await summary(db, '1003');
    const sub = await addSub(db, '1003', 'Own money', 'independent');
    await give(db, sub, 300);
    await sql(db, `insert into public.expenses (campaign_id, amount) values ($1, 500)`, [sub]);
    expect(n((await summary(db, sub)).balance)).toBe(-200);
    expect(n((await summary(db, '1003')).balance)).toBe(n(before.balance));
    expect(n((await summary(db, '1003')).combined_raised)).toBe(n(before.raised));
    await sql(db, `insert into public.transfers (amount, from_campaign_id, to_campaign_id) values (50, '1003', $1)`, [sub]);
    expect(n((await summary(db, sub)).balance)).toBe(-150);
  });

  it('shared: refuse expenses and transfers', async () => {
    const sub = await addSub(db, '1003', 'Table 1');
    await expect(sql(db, `insert into public.expenses (campaign_id, amount) values ($1, 5)`, [sub])).rejects.toThrow(/no balance of its own/);
    await expect(sql(db, `insert into public.transfers (amount, from_campaign_id, to_campaign_id) values (5, '1003', $1)`, [sub])).rejects.toThrow(/no balance of its own/);
    await expect(sql(db, `insert into public.transfers (amount, from_campaign_id, to_campaign_id) values (5, $1, '1003')`, [sub])).rejects.toThrow(/no balance of its own/);
  });

  it('total the same across all campaigns however they are arranged', async () => {
    const total = async () => (await rows<{ s: string }>(db, ADMIN, `select sum(balance) s from public.campaign_summary`))[0].s;
    const start = n(await total());
    const a = await addSub(db, '1003', 'A');
    const b = await addSub(db, a, 'B');
    const c = await addSub(db, '1003', 'C', 'independent');
    await give(db, a, 10); await give(db, b, 20); await give(db, c, 40);
    expect(n(await total())).toBe(start + 70);
    await sql(db, `select public.set_balance_mode($1, 'independent', 30)`, [a]);
    expect(n(await total())).toBe(start + 70);
    await sql(db, `select public.set_balance_mode($1, 'shared', 40)`, [c]);
    expect(n(await total())).toBe(start + 70);
  });

  it('shared to independent: what it raised becomes its balance, leaving the parent', async () => {
    const start = n((await summary(db, '1003')).balance);
    const sub = await addSub(db, '1003', 'Table 1');
    await give(db, sub, 500, 25);
    expect(n((await rows<{ a: string }>(db, ADMIN, `select public.balance_mode_amount($1) as a`, [sub]))[0].a)).toBe(475);
    await expect(sql(db, `select public.set_balance_mode($1, 'independent', 400)`, [sub])).rejects.toThrow(/balance is now 475/);
    await sql(db, `select public.set_balance_mode($1, 'independent', 475)`, [sub]);
    expect(n((await summary(db, sub)).balance)).toBe(475);
    expect(n((await summary(db, '1003')).balance)).toBe(start);
    const [log] = await rows<Record<string, any>>(db, ADMIN, `select old_mode, new_mode, amount, changed_by from public.campaign_mode_changes where campaign_id = $1`, [sub]);
    expect(log).toEqual({ old_mode: 'shared', new_mode: 'independent', amount: '475.00', changed_by: 'office@example.org' });
  });

  it('independent to shared: its balance is absorbed into the parent, and logged', async () => {
    const start = n((await summary(db, '1003')).balance);
    const sub = await addSub(db, '1003', 'Own money', 'independent');
    await give(db, sub, 300);
    await sql(db, `insert into public.expenses (campaign_id, amount) values ($1, 100)`, [sub]);
    await sql(db, `select public.set_balance_mode($1, 'shared', 200)`, [sub]);
    expect(n((await summary(db, sub)).balance)).toBe(0);
    expect(n((await summary(db, '1003')).balance)).toBe(start + 200);
    const [log] = await rows<Record<string, any>>(db, ADMIN, `select note from public.campaign_mode_changes where campaign_id = $1`, [sub]);
    expect(log.note).toMatch(/Absorbed into parent/);
  });

  it('only change mode by the function, by an admin, on a sub-campaign', async () => {
    const sub = await addSub(db, '1003', 'Table 1');
    await expect(sql(db, `update public.campaigns set balance_mode = 'independent' where id = $1`, [sub])).rejects.toThrow(/Change balance mode/);
    await expect(sql(db, `update public.campaigns set parent_campaign_id = '1001' where id = $1`, [sub])).rejects.toThrow(/can't be moved/);
    await expect(sql(db, `select public.set_balance_mode('1003', 'shared', 0)`)).rejects.toThrow(/Only a sub-campaign/);
    await expect(sql(db, `select public.set_balance_mode($1, 'shared', 0)`, [sub])).rejects.toThrow(/already uses/);
    await expect(sql(db, `select public.set_balance_mode($1, 'independent', 0)`, [sub], MANAGER_1)).rejects.toThrow(/Only admins/);
  });

  it('follow an archived or closed parent, but not back', async () => {
    const a = await addSub(db, '1003', 'A');
    const b = await addSub(db, a, 'B');
    await sql(db, `update public.campaigns set status = 'archived' where id = '1003'`);
    expect((await summary(db, a)).status).toBe('archived');
    expect((await summary(db, b)).status).toBe('archived');
    await sql(db, `update public.campaigns set status = 'active' where id = '1003'`);
    expect((await summary(db, a)).status).toBe('archived');
    await sql(db, `update public.campaigns set status = 'active' where id = $1`, [a]);
    expect((await summary(db, a)).status).toBe('active');
    expect((await summary(db, b)).status).toBe('archived');
    await sql(db, `update public.campaigns set status = 'closed' where id = '1003'`);
    expect((await summary(db, b)).status).toBe('closed');
    await expect(addSub(db, '1003', 'Late')).rejects.toThrow(/closed/);
  });

  it('come back on their own when a gift arrives', async () => {
    const a = await addSub(db, '1003', 'A');
    await sql(db, `update public.campaigns set status = 'archived' where id = $1`, [a]);
    await give(db, a, 10);
    expect((await summary(db, a)).status).toBe('active');
    expect((await summary(db, '1003')).status).toBe('active');
  });

  it("can't be deleted while they hold anything", async () => {
    const a = await addSub(db, '1003', 'A');
    const b = await addSub(db, a, 'B');
    await expect(sql(db, `delete from public.campaigns where id = $1`, [a])).rejects.toThrow(/has sub-campaigns/);
    const d = await give(db, b, 10);
    await expect(sql(db, `delete from public.campaigns where id = $1`, [b])).rejects.toThrow(/transactions/);
    await sql(db, `select public.delete_donation($1, 'test')`, [d]);
    await sql(db, `delete from public.campaigns where id = $1`, [b]);
    await sql(db, `delete from public.campaigns where id = $1`, [a]);
  });

  it('are added by an admin or the primary fundraiser only', async () => {
    await expect(addSub(db, '1003', 'Nope', 'shared', null, MANAGER_1)).rejects.toThrow(/primary fundraiser/);
    expect(await addSub(db, '1003', 'Yes', 'shared', null, MANAGER_2)).toBeTruthy();
    await expect(addSub(db, '1001', 'Nope', 'shared', null, MANAGER_2)).rejects.toThrow(/primary fundraiser/);
  });

  it('scope access: a parent fundraiser sees it all, a sub fundraiser only the sub', async () => {
    const sub = await addSub(db, '1002', 'Table 1', 'shared', 'm1');
    const d = await give(db, sub, 100);
    // m1 is on the sub only; m2 is the parent's primary.
    const onSub = await rows<{ id: string; balance: string }>(db, MANAGER_1, `select id, balance from public.campaign_summary where id in ('1002', $1)`, [sub]);
    expect(onSub.map(r => r.id)).toEqual([sub]);
    expect(n(onSub[0].balance)).toBe(0);
    expect(await rows(db, MANAGER_1, `select id from public.donations where campaign_id = '1002'`)).toEqual([]);
    expect((await rows<{ id: string }>(db, MANAGER_1, `select id from public.donations where id = $1`, [d])).length).toBe(1);

    const parent = await summary(db, '1002', MANAGER_2);
    const admin = await summary(db, '1002');
    expect(n(parent.balance)).toBe(n(admin.balance));
    expect(n(parent.combined_raised)).toBe(n(admin.combined_raised));
    expect((await rows<{ id: string }>(db, MANAGER_2, `select id from public.donations where id = $1`, [d])).length).toBe(1);
  });

  it('follow the parent fee until they set their own', async () => {
    await sql(db, `update public.payment_methods set fee_type = 'percent', fee_percent = 3 where name = 'Wire'`);
    const [m] = await rows<{ id: string }>(db, ADMIN, `select id from public.payment_methods where name = 'Wire'`);
    await sql(db, `insert into public.campaign_fee_overrides (campaign_id, method_id, fee_type, fee_percent) values ('1003', $1, 'percent', 1)`, [m.id]);
    const sub = await addSub(db, '1003', 'A');
    const leaf = await addSub(db, sub, 'B');
    const fee = async (c: string) => (await rows<{ f: string }>(db, ADMIN, `select public.calculate_fee(org_id, $1, 'Wire', 100) f from public.campaigns where id = $1`, [c]))[0].f;
    expect(await fee(leaf)).toBe('1.00');
    await sql(db, `insert into public.campaign_fee_overrides (campaign_id, method_id, fee_type, fee_percent) values ($1, $2, 'percent', 2)`, [sub, m.id]);
    expect(await fee(leaf)).toBe('2.00');
    expect(await fee('1003')).toBe('1.00');
    expect(await fee('1001')).toBe('3.00');
  });
});

describe('bank routing', () => {
  let db: PGlite;
  const account = async (id: string) => {
    await sql(db, `insert into public.accounts (id, name) values ($1, $1)`, [id]);
  };
  const routed = async (values: Record<string, unknown>) => {
    const v = { amount: 10, type: 'Payment', status: 'completed', ...values };
    const keys = Object.keys(v);
    const [r] = await rows<{ account_id: string }>(db, ADMIN,
      `insert into public.donations (${keys.join(',')}) values (${keys.map((_, i) => `$${i + 1}`).join(',')}) returning account_id`, Object.values(v));
    return r.account_id;
  };
  beforeEach(async () => {
    db = await seededDb();
    await account('b2'); await account('b3'); await account('b4');
    await sql(db, `select public.set_default_account('a1')`);
  });

  it('uses the default when nothing overrides it', async () => {
    expect(await routed({ campaign_id: '1003', payment_method: 'Cash' })).toBe('a1');
  });

  it('prefers the payment method over the default', async () => {
    await sql(db, `update public.payment_methods set account_id = 'b2' where name = 'Wire'`);
    expect(await routed({ campaign_id: '1003', payment_method: 'wire' })).toBe('b2');
    expect(await routed({ campaign_id: '1003', payment_method: 'Cash' })).toBe('a1');
  });

  it('prefers the campaign over everything, regardless of method', async () => {
    await sql(db, `update public.payment_methods set account_id = 'b2' where name = 'Wire'`);
    await sql(db, `update public.campaigns set account_id = 'b3' where id = '1003'`);
    expect(await routed({ campaign_id: '1003', payment_method: 'Wire' })).toBe('b3');
    await sql(db, `update public.campaigns set account_id = null where id = '1003'`);
    expect(await routed({ campaign_id: '1003', payment_method: 'Wire' })).toBe('b2');
  });

  it('passes down to sub-campaigns unless they set their own', async () => {
    await sql(db, `update public.campaigns set account_id = 'b3' where id = '1003'`);
    const sub = await addSub(db, '1003', 'A');
    expect(await routed({ campaign_id: sub, payment_method: 'Cash' })).toBe('b3');
    await sql(db, `update public.campaigns set account_id = 'b4' where id = $1`, [sub]);
    expect(await routed({ campaign_id: sub, payment_method: 'Cash' })).toBe('b4');
  });

  it('keeps an account entered by hand, and old records as they were', async () => {
    expect(await routed({ campaign_id: '1003', payment_method: 'Cash', account_id: 'b4' })).toBe('b4');
    await sql(db, `update public.campaigns set account_id = 'b3' where id = '1003'`);
    const [p] = await rows<{ account_id: string | null }>(db, ADMIN, `select account_id from public.donations where id = 'p3'`);
    expect(p.account_id).not.toBe('b3');
  });

  it('routes voucher funding, batches, and a payment with no campaign', async () => {
    await sql(db, `update public.campaigns set account_id = 'b3' where id = '1003'`);
    await rows(db, ADMIN, `select public.submit_batch('1003', 'k1', '[{"amount":5,"payment_method":"Cash"}]'::jsonb)`);
    expect((await rows<{ account_id: string }>(db, ADMIN, `select account_id from public.donations where amount = 5`))[0].account_id).toBe('b3');
    expect(await routed({ payment_method: 'Cash' })).toBe('a1');
  });

  it('lets only the Super Admin change the default, however they try', async () => {
    const [{ sa }] = (await db.query<{ sa: string }>(`select count(*)::text as sa from public.org_members where role = 'super_admin'`)).rows;
    expect(sa).toBeTruthy();
    await expect(sql(db, `select public.set_default_account('b2')`, [], MANAGER_1)).rejects.toThrow(/Super Admin/);
    await expect(sql(db, `select public.set_default_account('nope')`)).rejects.toThrow(/not found/);
  });
});

describe('transfers', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); });
  const add = (from: string | null, to: string | null, amount = 10, cross = false) =>
    sql(db, `insert into public.transfers (amount, from_campaign_id, to_campaign_id, cross_account) values ($1, $2, $3, $4)`, [amount, from, to, cross]);

  it('move money both ways, and can go below zero', async () => {
    const [a, b] = [n((await summary(db, '1001')).balance), n((await summary(db, '1003')).balance)];
    await add('1001', '1003', a + 100);
    expect(n((await summary(db, '1001')).balance)).toBe(-100);
    expect(n((await summary(db, '1003')).balance)).toBe(b + a + 100);
  });

  it('need two different campaigns and a positive amount', async () => {
    await expect(add(null, '1003')).rejects.toThrow(/both a source/);
    await expect(add('1003', null)).rejects.toThrow(/both a source/);
    await expect(add('1003', '1003')).rejects.toThrow(/two different/);
    await expect(add('1001', '1003', 0)).rejects.toThrow(/above zero/);
    await expect(add('1001', '1003', -5)).rejects.toThrow(/above zero/);
  });

  it("can't be changed or deleted, only reversed, though the memo can", async () => {
    await expect(sql(db, `update public.transfers set amount = 1 where id = 't1'`)).rejects.toThrow(/reverse transfer/);
    await expect(sql(db, `update public.transfers set to_campaign_id = '1003' where id = 't1'`)).rejects.toThrow(/reverse transfer/);
    await expect(sql(db, `delete from public.transfers where id = 't1'`)).rejects.toThrow(/reverse transfer/);
    await sql(db, `update public.transfers set description = 'fixed memo' where id = 't1'`);
  });

  it('between bank accounts must be marked as such', async () => {
    await sql(db, `insert into public.accounts (id, name) values ('b2', 'Second')`);
    await sql(db, `update public.campaigns set account_id = 'b2' where id = '1003'`);
    await expect(add('1001', '1003')).rejects.toThrow(/different bank accounts/);
    await add('1001', '1003', 10, true);
    await sql(db, `update public.campaigns set account_id = 'b2' where id = '1001'`);
    await add('1001', '1003');
  });

  it('are invisible to fundraisers, while their balance still includes them', async () => {
    expect(await rows(db, MANAGER_1, `select id from public.transfers`)).toEqual([]);
    expect(await rows(db, MANAGER_2, `select id from public.transfers`)).toEqual([]);
    const [fundraiser, admin] = [await summary(db, '1001', MANAGER_1), await summary(db, '1001')];
    expect(n(fundraiser.balance)).toBe(n(admin.balance));
    expect(n(admin.expenses)).toBeGreaterThanOrEqual(75);
  });

  it("don't show totals for campaigns someone isn't on", async () => {
    const seen = await rows<{ campaign_id: string }>(db, MANAGER_1, `select campaign_id from public.campaign_transfer_totals()`);
    expect(seen.map(r => r.campaign_id)).toEqual(['1001']);
    const other = await rows<{ campaign_id: string }>(db, MANAGER_2, `select campaign_id from public.campaign_transfer_totals()`);
    expect(other.map(r => r.campaign_id)).toEqual(['1002']);
  });
});
