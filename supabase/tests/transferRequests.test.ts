import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, MANAGER_1, MANAGER_2, OIZER, rows, seededDb } from './harness';

// Moshe Henig, 2026-11-15: fundraisers request transfers between their own campaigns; an admin approves on the Task Sheet.
const one = async (db: PGlite, q: string, params: unknown[] = [], user = ADMIN) => (await rows(db, user, q, params))[0];

describe('transfer requests', () => {
  let base: PGlite;
  let db: PGlite;
  beforeAll(async () => {
    base = await seededDb();
    await base.query(`insert into public.campaigns (org_id, id, internal_name, manager_id, sub_manager_ids, status) values ($1, '1009', 'Sample second', 'm1', '{}', 'active') on conflict do nothing`, [OIZER]);
  });
  beforeEach(async () => { db = await base.clone(); });
  const ask = (db: PGlite, from = '1001', to = '1009', amount = 25, user = MANAGER_1) =>
    one(db, `select public.request_transfer($1, $2, $3, 'Sample reason') as id`, [from, to, amount], user).then(r => r.id as string);

  it('puts a request between their own campaigns on the Task Sheet, and moves nothing until approved', async () => {
    const id = await ask(db);
    expect(await one(db, `select status, amount from public.transfer_requests where id = $1`, [id])).toEqual({ status: 'pending', amount: '25.00' });
    const [task] = await rows(db, ADMIN, `select task_type, summary from public.admin_task_sheet where task_key = $1`, [`transfer_request:${id}`]);
    expect(task.task_type).toBe('transfer_request');
    expect(task.summary).toMatch(/move \$25\.00 from 1001 to 1009: Sample reason/);
    expect((await rows(db, ADMIN, `select * from public.transfers where description = 'Sample reason'`)).length).toBe(0);
  });

  it('makes the transfer when an admin approves, and only then', async () => {
    const id = await ask(db);
    await expect(rows(db, MANAGER_1, `select public.decide_transfer_request($1, true)`, [id])).rejects.toThrow();
    const { t } = await one(db, `select public.decide_transfer_request($1, true, 'OK') as t`, [id]);
    expect(await one(db, `select amount, from_campaign_id, to_campaign_id from public.transfers where id = $1`, [t])).toEqual({ amount: '25.00', from_campaign_id: '1001', to_campaign_id: '1009' });
    expect(await one(db, `select status, transfer_id, admin_note from public.transfer_requests where id = $1`, [id])).toEqual({ status: 'approved', transfer_id: t, admin_note: 'OK' });
    expect((await rows(db, ADMIN, `select * from public.admin_task_sheet where task_key = $1`, [`transfer_request:${id}`])).length).toBe(0);
    await expect(rows(db, ADMIN, `select public.decide_transfer_request($1, false)`, [id])).rejects.toThrow(/already handled/);
  });

  it('refuses campaigns that aren’t theirs as primary, direct transfers, and shows each fundraiser only their own', async () => {
    await expect(ask(db, '1001', '1002')).rejects.toThrow(/primary fundraiser/);
    await expect(ask(db, '1001', '1003')).rejects.toThrow(/primary fundraiser/);   // m1 is only secondary there
    await expect(ask(db, '1001', '1001')).rejects.toThrow(/two different/);
    await expect(rows(db, MANAGER_1, `insert into public.transfers (amount, from_campaign_id, to_campaign_id) values (1, '1001', '1009')`)).rejects.toThrow();
    await expect(rows(db, MANAGER_1, `insert into public.transfer_requests (manager_id, from_campaign_id, to_campaign_id, amount) values ('m1', '1001', '1009', 1)`)).rejects.toThrow();
    const id = await ask(db);
    expect((await rows(db, MANAGER_1, `select id from public.transfer_requests`)).map(r => r.id)).toEqual([id]);
    expect(await rows(db, MANAGER_2, `select id from public.transfer_requests`)).toEqual([]);
  });

  it('can be withdrawn by the fundraiser while waiting, or rejected by an admin', async () => {
    const a = await ask(db);
    await rows(db, MANAGER_1, `select public.withdraw_transfer_request($1)`, [a]);
    expect((await one(db, `select status from public.transfer_requests where id = $1`, [a])).status).toBe('withdrawn');
    const b = await ask(db);
    await expect(rows(db, MANAGER_2, `select public.withdraw_transfer_request($1)`, [b])).rejects.toThrow();
    await one(db, `select public.decide_transfer_request($1, false, 'Not now')`, [b]);
    expect((await one(db, `select status from public.transfer_requests where id = $1`, [b])).status).toBe('rejected');
  });
});
