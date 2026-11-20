import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, MANAGER_1, OIZER, rows, seededDb } from './harness';

// Moshe Henig, 2026-11-15: fundraisers see transfers in and out of their campaigns, read-only.
describe('campaign transfers for fundraisers', () => {
  let base: PGlite;
  let db: PGlite;
  beforeAll(async () => {
    base = await seededDb();
    await base.query(`insert into public.transfers (org_id, id, amount, from_campaign_id, to_campaign_id, description, notes, created_by)
      values ($1, 'tx-sample-1', 50, '1002', '1001', 'Sample move in', 'internal note', 'office@example.org'),
             ($1, 'tx-sample-2', 20, '1001', '1002', 'Sample move out', null, 'office@example.org')`, [OIZER]);
  });
  beforeEach(async () => { db = await base.clone(); });

  it('shows a fundraiser their campaign’s transfers, naming only campaigns they work on', async () => {
    const r = await rows(db, MANAGER_1, `select id, direction, amount, other_campaign_id, other_campaign_name, description from public.campaign_transfers('1001') where id like 'tx-sample-%' order by id`);
    expect(r).toEqual([
      { id: 'tx-sample-1', direction: 'in', amount: '50.00', other_campaign_id: null, other_campaign_name: 'another campaign', description: 'Sample move in' },
      { id: 'tx-sample-2', direction: 'out', amount: '20.00', other_campaign_id: null, other_campaign_name: 'another campaign', description: 'Sample move out' },
    ]);
    expect(JSON.stringify(r)).not.toContain('internal note');
  });

  it('shows nothing for someone else’s campaign, and the table stays admin-only', async () => {
    expect(await rows(db, MANAGER_1, `select * from public.campaign_transfers('1002')`)).toEqual([]);
    expect(await rows(db, MANAGER_1, `select * from public.transfers`)).toEqual([]);
    await expect(rows(db, MANAGER_1, `insert into public.transfers (id, amount, from_campaign_id, to_campaign_id) values ('x', 1, '1001', '1002')`)).rejects.toThrow();
  });

  it('gives admins every transfer with the other campaign named', async () => {
    const r = await rows(db, ADMIN, `select id, other_campaign_id from public.campaign_transfers('1001') where id like 'tx-sample-%' order by id`);
    expect(r).toEqual([{ id: 'tx-sample-1', other_campaign_id: '1002' }, { id: 'tx-sample-2', other_campaign_id: '1002' }]);
  });
});
