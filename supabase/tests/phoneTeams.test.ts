import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, OIZER, rows, seededDb } from './harness';

// Moshe Henig, 2026-11-11: the phone line's Teams option, for known callers on a call that reached the campaign.
const DONOR_PHONE = '+18455550123';
const STRANGER = '+12125550199';
const svc = async <T = any>(db: PGlite, q: string, p: unknown[] = []) => (await rows<T>(db, 'service_role', q, p))[0];
const teams = async (db: PGlite, from: string, call = 'CA1', campaign = '1002') =>
  (await svc<{ t: any[] }>(db, `select public.phone_teams($1, $2, $3, $4) t`, [OIZER, from, call, campaign])).t;

describe('phone line teams', () => {
  let base: PGlite;
  let db: PGlite;
  beforeAll(async () => {
    base = await seededDb();
    await rows(base, ADMIN, `select public.add_sub_campaign('1002', 'Table 1', 'shared')`);
    await rows(base, ADMIN, `select public.add_sub_campaign('1002', 'Branch', 'independent')`);
    await rows(base, ADMIN, `select public.add_sub_campaign('1002', 'Table 2', 'shared')`);
    await base.query(`update public.donors set phone = '845-555-0123' where id = 'd1'`);
  });
  beforeEach(async () => { db = await base.clone(); });

  it('knows donors, fundraisers and admins on file, and no one else', async () => {
    expect((await svc(db, `select public.phone_known_caller($1, $2) k`, [OIZER, DONOR_PHONE])).k).toBe(true);
    expect((await svc(db, `select public.phone_known_caller($1, $2) k`, [OIZER, STRANGER])).k).toBe(false);
  });

  it('lists the teams numbered 1, 2... only after this call reached the campaign', async () => {
    expect(await teams(db, DONOR_PHONE)).toEqual([]);
    await svc(db, `select public.phone_call_reached($1, 'CA1', '1002')`, [OIZER]);
    expect((await teams(db, DONOR_PHONE)).map(t => [t.n, t.id, t.name])).toEqual([[1, '1002A', 'Table 1'], [2, '1002C', 'Table 2']]);
    expect(await teams(db, DONOR_PHONE, 'CA2')).toEqual([]);           // another call
    expect(await teams(db, STRANGER)).toEqual([]);                     // not on file
    expect((await svc(db, `select public.phone_pick_team($1, $2, 'CA1', '1002', 2) t`, [OIZER, DONOR_PHONE])).t).toMatchObject({ id: '1002C', name: 'Table 2' });
    expect((await svc(db, `select public.phone_pick_team($1, $2, 'CA1', '1002', 9) t`, [OIZER, DONOR_PHONE])).t).toBeNull();
  });

  it('are not reachable by signed-in users or the public', async () => {
    await expect(rows(db, ADMIN, `select public.phone_teams($1, $2, 'CA1', '1002')`, [OIZER, DONOR_PHONE])).rejects.toThrow();
    await expect(rows(db, 'anon', `select public.phone_call_reached($1, 'CA1', '1002')`, [OIZER])).rejects.toThrow();
  });
});
