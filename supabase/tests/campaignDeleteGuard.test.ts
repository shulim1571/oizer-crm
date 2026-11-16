import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, OIZER, as, seededDb } from './harness';

// Readiness #53 (2026-11-15): a campaign with live teams or money left can't be deleted.
const del = (db: PGlite, id: string) => as(db, ADMIN, tx => tx.query(`delete from public.campaigns where id = $1`, [id]), OIZER);
const gone = async (db: PGlite, id: string) => (await db.query<{ d: string | null }>(`select deleted_at d from public.campaigns where id = $1`, [id])).rows[0].d !== null;

describe('deleting a campaign', () => {
  let base: PGlite;
  let db: PGlite;
  beforeAll(async () => { base = await seededDb(); });
  beforeEach(async () => { db = await base.clone(); });

  it('is refused while a team counts in its balance', async () => {
    await db.query(`insert into public.campaigns (org_id, id, internal_name, status, parent_campaign_id, balance_mode) values ($1, 'T1', 'Team', 'active', '1003', 'shared')`, [OIZER]);
    await expect(del(db, '1003')).rejects.toThrow(/has sub-campaigns/);   // the existing tree rule
    expect(await gone(db, '1003')).toBe(false);
  });

  it('is refused while it has money left', async () => {
    await expect(del(db, '1001')).rejects.toThrow(/still has a balance/);
    expect(await gone(db, '1001')).toBe(false);
  });

  it('goes ahead for an empty campaign with nothing under it', async () => {
    await db.query(`insert into public.campaigns (org_id, id, internal_name, status) values ($1, 'EMPTY', 'Empty', 'active')`, [OIZER]);
    await del(db, 'EMPTY');
    expect(await gone(db, 'EMPTY')).toBe(true);
  });
});
