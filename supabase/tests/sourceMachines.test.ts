import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, MANAGER_1, OIZER, rows, seededDb } from './harness';

// Shulim, 2026-11-13: Sources and Donary machines are one list; a Donary machine is a source marked as one.
const q = (db: PGlite, sql: string, params: unknown[] = [], user = ADMIN) => rows(db, user, sql, params);

describe('Donary machines are sources', () => {
  let base: PGlite;
  let db: PGlite;
  beforeAll(async () => {
    base = await seededDb();
    await base.query(`insert into public.sources (org_id, id, name) values ($1, 'DP_SAMPLE_9', 'DP_SAMPLE_9') on conflict do nothing`, [OIZER]);
  });
  beforeEach(async () => { db = await base.clone(); });

  it('marks a source as a machine, retires it, and brings the same machine back', async () => {
    const [{ id }] = await q(db, `select public.set_source_donary_machine('DP_SAMPLE_9', true) as id`);
    const flag = async () => (await q(db, `select donary_machine from public.sources where id = 'DP_SAMPLE_9'`))[0].donary_machine;
    const [m] = await q(db, `select nickname, donary_id, active, source_id from public.machines where id = $1`, [id]);
    expect(m).toMatchObject({ donary_id: 'DP_SAMPLE_9', active: true, source_id: 'DP_SAMPLE_9' });
    expect(await flag()).toBe(true);
    await q(db, `select public.set_source_donary_machine('DP_SAMPLE_9', false)`);
    expect(await flag()).toBe(false);
    expect((await q(db, `select active from public.machines where id = $1`, [id]))[0].active).toBe(false);
    const [{ again }] = await q(db, `select public.set_source_donary_machine('DP_SAMPLE_9', true) as again`);
    expect(again).toBe(id);
    expect(await flag()).toBe(true);
  });

  it('gives a machine registered without a source its own source, one machine per source, admins only', async () => {
    const [{ id }] = await q(db, `select public.register_machine('DP_SAMPLE_10', null, null, null, null) as id`);
    const [m] = await q(db, `select m.source_id, s.name, s.donary_machine from public.machines m join public.sources s on s.org_id = m.org_id and s.id = m.source_id where m.id = $1`, [id]);
    expect(m.source_id).toBe('DP_SAMPLE_10');
    expect(m.donary_machine).toBe(true);
    await expect(q(db, `select public.register_machine('DP_SAMPLE_11', null, null, null, 'DP_SAMPLE_10')`)).rejects.toThrow();
    await expect(q(db, `select public.set_source_donary_machine('DP_SAMPLE_9', true)`, [], MANAGER_1)).rejects.toThrow();
  });
});
