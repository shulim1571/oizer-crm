import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, MANAGER_1, OIZER, PENDING, rows, seededDb } from './harness';

// Address suggestions while typing (Shulim, 2026-11-25): each lookup is booked as the person first, so Azure Maps stays
// within its free tier. Staff only; 20 a minute per person, 150 a day per organization, 4,500 a month in all.
const begin = (db: PGlite, who = ADMIN) => rows<{ address_suggest_begin: string }>(db, who, 'select public.address_suggest_begin()', [], OIZER);
const fill = (db: PGlite, sql: string) => db.exec(sql);
const OTHER = '00000000-0000-4000-8000-0000000000b2';

describe('address suggestion lookups', () => {
  let base: PGlite;
  let db: PGlite;
  beforeAll(async () => { base = await seededDb(); });
  beforeEach(async () => { db = await base.clone(); });

  it('books a lookup for staff and names the organization, keeping only who and when', async () => {
    expect((await begin(db))[0].address_suggest_begin).toBe(OIZER);
    expect((await begin(db, MANAGER_1))[0].address_suggest_begin).toBe(OIZER);
    const [r] = (await db.query<{ n: number; cols: string }>(`select count(*)::int n, (select string_agg(column_name, ',' order by column_name) from information_schema.columns where table_name = 'address_lookups') cols from public.address_lookups`)).rows;
    expect(r.n).toBe(2);
    expect(r.cols).toBe('created_at,id,org_id,user_id');   // never what was typed
  });

  it('refuses people who aren\'t active staff, and the lookups table is closed to everyone', async () => {
    await expect(begin(db, PENDING)).rejects.toThrow(/Sign in to look up addresses/);
    await expect(rows(db, ADMIN, 'select * from public.address_lookups', [], OIZER)).rejects.toThrow(/permission denied/);
  });

  it('pauses a person after 20 lookups in a minute', async () => {
    await fill(db, `insert into public.address_lookups (org_id, user_id) select '${OIZER}', '${ADMIN}' from generate_series(1, 20)`);
    await expect(begin(db)).rejects.toThrow(/paused for a moment/);
    expect((await begin(db, MANAGER_1))[0].address_suggest_begin).toBe(OIZER);   // someone else still can
  });

  it('stops an organization at 150 a day', async () => {
    await fill(db, `insert into public.address_lookups (org_id, user_id, created_at) select '${OIZER}', gen_random_uuid(), now() - interval '2 hours' from generate_series(1, 150)`);
    await expect(begin(db, MANAGER_1)).rejects.toThrow(/today's limit/);
  });

  it('stops everyone at 4,500 a month, and clears rows older than 40 days', async () => {
    // Booked to another organization at the start of this month, so only the monthly limit applies to Oizer.
    await fill(db, `insert into public.organizations (id, slug, name) values ('${OTHER}', 'other', 'Other Org');
      insert into public.address_lookups (org_id, user_id, created_at) select '${OTHER}', gen_random_uuid(), date_trunc('month', now()) from generate_series(1, 4500)`);
    await expect(begin(db)).rejects.toThrow(/this month's limit/);
    await fill(db, `delete from public.address_lookups; insert into public.address_lookups (org_id, user_id, created_at) values ('${OIZER}', gen_random_uuid(), now() - interval '41 days')`);
    await begin(db);
    expect((await db.query<{ n: number }>(`select count(*)::int n from public.address_lookups where created_at < now() - interval '40 days'`)).rows[0].n).toBe(0);
  });
});
