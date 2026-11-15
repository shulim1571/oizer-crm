import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, MANAGER_1, OIZER, as, rows, seededDb } from './harness';

// Moshe Henig, 2026-11-15: open screens update on their own. Writes leave a tiny ping (org, topic, time; no donation
// data), one per statement, that Realtime passes on to the screens listening.
const OTHER = '00000000-0000-4000-8000-0000000000ee';
const OTHER_ADMIN = '00000000-0000-0000-0000-0000000000ee';
const sql = (db: PGlite, q: string) => as(db, ADMIN, tx => tx.query(q), OIZER);
const pings = async (db: PGlite) => (await db.query<{ topic: string; n: number }>(
  `select topic, count(*)::int n from public.live_pings group by topic order by topic`)).rows;

describe('live refresh pings', () => {
  let base: PGlite;
  let db: PGlite;
  beforeAll(async () => {
    base = await seededDb();
    await base.exec(`
      insert into public.organizations (id, slug, name) values ('${OTHER}', 'other', 'Other Org');
      insert into auth.users (id, email) values ('${OTHER_ADMIN}', 'admin@other.example');
      insert into public.org_members (org_id, user_id, role) values ('${OTHER}', '${OTHER_ADMIN}', 'admin');
      delete from public.live_pings;`);
  });
  beforeEach(async () => { db = await base.clone(); });

  it('pings once per statement and organization, even for a bulk write', async () => {
    await sql(db, `insert into public.donations (id, campaign_id, type, status, amount, payment_method)
                   select 'lp-' || g, '1001', 'Payment', 'completed', 10, 'Cash' from generate_series(1, 50) g`);
    // The gift's own triggers may touch campaigns and pledges too; the gifts ping is exactly one.
    expect((await pings(db)).find(p => p.topic === 'gifts')?.n).toBe(1);
    await sql(db, `update public.donations set notes = 'x' where id like 'lp-%'`);
    await sql(db, `delete from public.donations where id = 'lp-1'`);
    expect((await pings(db)).find(p => p.topic === 'gifts')?.n).toBe(3);
  });

  it('pings the topic of each kind of record', async () => {
    await sql(db, `update public.campaigns set internal_name = internal_name where id = '1001'`);
    expect((await pings(db)).map(p => p.topic)).toContain('campaigns');
    const [{ tabs }] = (await db.query<{ tabs: string[] }>(`select array_agg(distinct event_object_table::text order by event_object_table::text) tabs
      from information_schema.triggers where trigger_name like 'live_ping_%'`)).rows;
    expect(tabs).toEqual(['bank_transfers', 'campaigns', 'checks', 'donations', 'expenses', 'payout_requests', 'pledge_installments',
      'pledge_payments', 'pledges', 'recurring_donations', 'transfer_requests', 'transfers']);
  });

  it('carries no donation data, and only members of that organization can see it', async () => {
    await sql(db, `insert into public.donations (id, campaign_id, type, status, amount, payment_method) values ('lp-x', '1001', 'Payment', 'completed', 10, 'Cash')`);
    await db.query(`insert into public.live_pings (org_id, topic) values ('${OTHER}', 'gifts')`);
    const cols = (await db.query<{ c: string }>(`select column_name c from information_schema.columns where table_schema = 'public' and table_name = 'live_pings' order by ordinal_position`)).rows.map(r => r.c);
    expect(cols).toEqual(['id', 'org_id', 'topic', 'at']);
    // No x-org-id header, as Realtime checks it: membership alone decides.
    const seen = async (who: string) => (await as(db, who, tx => tx.query<{ org_id: string }>(`select distinct org_id from public.live_pings`))).rows.map(r => r.org_id);
    expect(await seen(ADMIN)).toEqual([OIZER]);
    expect(await seen(MANAGER_1)).toEqual([OIZER]);
    expect(await seen(OTHER_ADMIN)).toEqual([OTHER]);
  });

  it("can't be written or cleared by users", async () => {
    await expect(rows(db, ADMIN, `insert into public.live_pings (org_id, topic) values ('${OIZER}', 'gifts')`, [], OIZER)).rejects.toThrow(/permission denied/);
    await expect(rows(db, ADMIN, `delete from public.live_pings`, [], OIZER)).rejects.toThrow(/permission denied/);
  });
});
