import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, OIZER, rows, seededDb } from './harness';

// Address suggestions on the public payment page (Moshe, 2026-11-25): booked by the Edge Function with the server key,
// only for an open payment page, with their own limits. Sample data only.
const pub = async (db: PGlite, campaign: string, who = 'conn-1') =>
  (await rows<{ m: string | null }>(db, 'service_role', 'select public.address_suggest_public_begin($1, $2, $3) m', [OIZER, campaign, who]))[0].m;
const staff = (db: PGlite) => rows(db, ADMIN, 'select public.address_suggest_begin()', [], OIZER);

describe('payment page address suggestions', () => {
  let base: PGlite;
  let db: PGlite;
  beforeAll(async () => {
    base = await seededDb();
    await base.exec(`update public.campaigns set status = 'active' where id in ('1001', '1002')`);
  });
  beforeEach(async () => { db = await base.clone(); });

  it('books a lookup for an open payment page, and keeps only the campaign and a connection hash', async () => {
    expect(await pub(db, '1001')).toBeNull();
    expect((await db.query(`select org_id, user_id, campaign_id, ip_hash from public.address_lookups`)).rows).toEqual([
      { org_id: OIZER, user_id: null, campaign_id: '1001', ip_hash: 'conn-1' }]);
  });

  it('refuses a page that isn\'t open', async () => {
    await db.exec(`update public.campaigns set status = 'closed' where id = '1002'`);
    expect(await pub(db, '1002')).toMatch(/aren't available on this page/);
    expect(await pub(db, 'no-such-campaign')).toMatch(/aren't available on this page/);
  });

  it('pauses one connection after 20 in 10 minutes or 60 in a day; others go on', async () => {
    await db.exec(`insert into public.address_lookups (org_id, campaign_id, ip_hash) select '${OIZER}', '1001', 'busy' from generate_series(1, 20)`);
    expect(await pub(db, '1001', 'busy')).toMatch(/paused for a moment/);
    expect(await pub(db, '1001', 'conn-2')).toBeNull();
    await db.exec(`insert into public.address_lookups (org_id, campaign_id, ip_hash, created_at) select '${OIZER}', '1001', 'daily', now() - interval '3 hours' from generate_series(1, 60)`);
    expect(await pub(db, '1001', 'daily')).toMatch(/paused for a moment/);
  });

  it('stops payment pages at 100 a day per organization, without touching the staff\'s own 150', async () => {
    await db.exec(`insert into public.address_lookups (org_id, campaign_id, ip_hash, created_at) select '${OIZER}', '1001', 'c' || g, now() - interval '2 hours' from generate_series(1, 100) g`);
    expect(await pub(db, '1001', 'fresh')).toMatch(/aren't available right now/);
    await staff(db);   // staff still can
    // And staff lookups don't use up the payment pages' allowance.
    await db.exec(`delete from public.address_lookups; insert into public.address_lookups (org_id, user_id, created_at) select '${OIZER}', gen_random_uuid(), now() - interval '2 hours' from generate_series(1, 149)`);
    expect(await pub(db, '1001', 'fresh')).toBeNull();
  });

  it('can only be called with the server key', async () => {
    await expect(rows(db, 'anon', `select public.address_suggest_public_begin($1, '1001', 'x')`, [OIZER])).rejects.toThrow(/permission denied/);
    await expect(rows(db, ADMIN, `select public.address_suggest_public_begin($1, '1001', 'x')`, [OIZER], OIZER)).rejects.toThrow(/permission denied/);
  });
});
