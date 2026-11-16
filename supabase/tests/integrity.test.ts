import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, OIZER, rows, seededDb } from './harness';

// Readiness #26 (2026-11-15): the nightly books check; seeded bad rows each show up, on the Task Sheet too.
const checks = async (db: PGlite) => Object.fromEntries((await db.query<{ check_key: string; n: number }>(
  `select check_key, n::int n from public.integrity_checks($1)`, [OIZER])).rows.map(r => [r.check_key, r.n]));
const add = (db: PGlite, id: string, cols: string, vals: string) =>
  db.query(`insert into public.donations (org_id, id, campaign_id, type, status, amount, ${cols}) values ('${OIZER}', '${id}', '1003', 'Payment', 'completed', 100, ${vals})`);

describe('nightly books check', () => {
  let base: PGlite;
  let db: PGlite;
  beforeAll(async () => { base = await seededDb(); });
  beforeEach(async () => { db = await base.clone(); });

  it('finds each kind of problem seeded into the books', async () => {
    const before = await checks(db);
    // A gift on a deleted campaign.
    await db.query(`insert into public.campaigns (org_id, id, internal_name, status) values ($1, 'GONE', 'Gone', 'active')`, [OIZER]);
    await db.query(`insert into public.donations (org_id, id, campaign_id, type, status, amount, manual_fee, payment_method) values ($1, 'i-orphan', 'GONE', 'Payment', 'completed', 10, 0, 'Cash')`, [OIZER]);
    await db.query(`update public.campaigns set deleted_at = now() where id = 'GONE'`);
    // Two imported gifts with one gateway reference.
    await add(db, 'AS-dup1', 'manual_fee, payment_method, gateway_id', `0, 'Cash', 'GW-DUP'`);
    await add(db, 'AS-dup2', 'manual_fee, payment_method, gateway_id', `0, 'Cash', 'GW-DUP'`);
    // Net off from amount less fee; a fee missing; a fee above the gift; no bank account.
    await add(db, 'i-net', 'manual_fee, payment_method', `0, 'Cash'`);
    await db.query(`update public.donations set net_donation = 90 where id = 'i-net'`);
    await add(db, 'i-nofee', 'payment_method', `'Bitcoin'`);
    await add(db, 'i-bigfee', 'manual_fee, payment_method', `0, 'Cash'`);
    await db.query(`update public.donations set fee = 150, net_donation = -50 where id = 'i-bigfee'`);
    await db.query(`update public.donations set account_id = null where id = 'i-net'`);
    // A batch deposit that doesn't add up.
    await add(db, 'i-batch', 'manual_fee, payment_method', `0, 'Cash'`);
    await db.query(`update public.donations set type = 'Batch', funded = 30, batch_pending = 10 where id = 'i-batch'`);
    // A campaign below zero.
    await db.query(`insert into public.expenses (org_id, id, campaign_id, amount, account_id) values ($1, 'i-exp', '1002', 999999, 'a1')`, [OIZER]);
    // A pledge payment on a gift that was voided (made by hand, around the clean-up trigger).
    await add(db, 'i-pp', 'manual_fee, payment_method', `0, 'Cash'`);
    await db.query(`update public.donations set status = 'voided' where id = 'i-pp'`);
    await db.query(`insert into public.pledge_payments (org_id, pledge_id, donation_id, amount, matched_by) values ($1, 'g1', 'i-pp', 50, 'manual')`, [OIZER]);
    // A voucher funded beyond its face value.
    const [{ id: v }] = await rows<{ id: string }>(db, ADMIN, `insert into public.vouchers (campaign_id, issuer, face_value, fee_type) values ('1003', 'Voucher — OJC Fund', 50, 'none') returning id`, [], OIZER);
    await add(db, 'i-vou', 'manual_fee, payment_method, voucher_id', `0, 'Cash', '${v}'`);
    // A reconciled gift whose amount changed after matching.
    await db.query(`insert into public.recon_matches (org_id, id, account_id, kind, lines_total, items_total, difference) values ($1, 'i-m', 'a1', 'manual', 100, 100, 0)`, [OIZER]);
    await db.query(`insert into public.recon_match_items (org_id, match_id, item_type, item_id, amount) values ($1, 'i-m', 'donation', 'i-net', 80)`, [OIZER]);
    // A processor refund recorded as a void (from before refunds were kept as refunds).
    await add(db, 'i-void', 'manual_fee, payment_method', `0, 'Cash'`);
    await db.query(`update public.donations set status = 'voided', reversal_reason = 'Voided at Sola (sent by Make)' where id = 'i-void'`);

    const after = await checks(db);
    for (const k of ['orphan_campaign', 'duplicate_refs', 'net_mismatch', 'fee_missing', 'fee_out_of_range', 'batch_mismatch', 'negative_balance',
                     'dead_pledge_payments', 'overfunded_vouchers', 'no_account', 'recon_changed', 'refunds_as_voids']) {
      expect(after[k] - (before[k] ?? 0), k).toBeGreaterThan(0);
    }
  });

  it('puts what it finds on the Task Sheet, keeps the run for the dashboard, and clears an item once fixed', async () => {
    await add(db, 'i-net2', 'manual_fee, payment_method', `0, 'Cash'`);
    await db.query(`update public.donations set net_donation = 90 where id = 'i-net2'`);
    const r1 = (await db.query<{ r: any }>(`select public.run_integrity($1) r`, [OIZER])).rows[0].r;
    expect(r1.ok).toBe(false);
    const open = async () => (await db.query<{ task_key: string }>(`select task_key from public.task_items where task_type = 'integrity' and resolved_at is null`)).rows.map(r => r.task_key);
    expect(await open()).toContain('integrity:net_mismatch');
    const run = await rows<{ ok: boolean }>(db, ADMIN, `select ok from public.integrity_runs order by ran_at desc limit 1`, [], OIZER);
    expect(run).toEqual([{ ok: false }]);
    await db.query(`update public.donations set net_donation = 100 where id = 'i-net2'`);
    await db.query(`select public.run_integrity($1)`, [OIZER]);
    expect(await open()).not.toContain('integrity:net_mismatch');
  });

  it('ties each campaign\'s raised figure to its gifts (readiness #9), teams included', async () => {
    expect((await checks(db)).raised_tieout).toBe(0);
    // A shared team with a gift: its parent's own raised figure doesn't include it, and nothing is off.
    await db.query(`insert into public.campaigns (org_id, id, internal_name, status, parent_campaign_id, balance_mode) values ($1, '1001T', 'Team', 'active', '1001', 'shared')`, [OIZER]);
    await db.query(`insert into public.donations (org_id, id, campaign_id, type, status, amount, manual_fee, payment_method) values ($1, 'i-team', '1001T', 'Payment', 'completed', 152, 0, 'Cash')`, [OIZER]);
    expect((await checks(db)).raised_tieout).toBe(0);
  });

  it('runs every night, and an admin can run it now', async () => {
    await db.query(`select public.run_job('integrity')`);
    const [job] = (await db.query<{ ok: boolean }>(`select ok from public.job_runs where job = 'integrity' order by id desc limit 1`)).rows;
    expect(job.ok).toBe(true);
    const [{ r }] = await rows<{ r: any }>(db, ADMIN, `select public.check_books_now() r`, [], OIZER);
    expect(Array.isArray(r.results)).toBe(true);
  });
});
