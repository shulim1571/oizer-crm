import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, MANAGER_1, MANAGER_2, OIZER, as, rows, seededDb } from './harness';

// Teams (shared balance) and sub-campaigns (independent) get the parent's ID plus a letter (Moshe Henig, 2026-11-11).
const sql = (db: PGlite, q: string, params: unknown[] = [], user = ADMIN) => as(db, user, tx => tx.query(q, params));
const add = async (db: PGlite, parent: string, name: string, mode = 'shared', user = ADMIN) =>
  (await rows<{ id: string }>(db, user, `select public.add_sub_campaign($1, $2, $3) as id`, [parent, name, mode]))[0].id;
const page = async (db: PGlite, id: string) =>
  (await rows<{ p: any }>(db, 'anon', `select public.public_give_page($1, $2) p`, [OIZER, id]))[0].p;

describe('teams and lettered IDs', () => {
  let base: PGlite;
  let db: PGlite;
  beforeAll(async () => { base = await seededDb(); });
  beforeEach(async () => { db = await base.clone(); });

  it('give teams and sub-campaigns the parent ID plus the next letter, in order, shared between them', async () => {
    expect(await add(db, '1002', 'Table 1')).toBe('1002A');
    expect(await add(db, '1002', 'Branch', 'independent')).toBe('1002B');
    expect(await add(db, '1002', 'Table 2')).toBe('1002C');
    expect(await add(db, '1003', 'Table 1')).toBe('1003A');
    // A child of a lettered campaign gets a dash so the letters stay readable.
    expect(await add(db, '1002A', 'Sub table')).toBe('1002A-A');
    // Ordinary campaigns keep their numbers.
    const [n] = await rows<{ id: string }>(db, ADMIN, `insert into public.campaigns (internal_name) values ('Plain') returning id`);
    expect(n.id).toMatch(/^\d+$/);
  });

  it('never reuse a letter, even after a deletion', async () => {
    const a = await add(db, '1002', 'Table 1');
    await sql(db, `delete from public.campaigns where id = $1`, [a]);
    expect(await add(db, '1002', 'Table 1 again')).toBe('1002B');
  });

  it('go past Z to AA', async () => {
    expect((await rows<{ s: string }>(db, ADMIN, `select string_agg(public.letter_suffix(n), ',') s from unnest(array[1, 26, 27, 52, 53, 702, 703]) n`))[0].s)
      .toBe('A,Z,AA,AZ,BA,ZZ,AAA');
  });

  it('list a team on the parent payment page only when turned on', async () => {
    const t = await add(db, '1002', 'Table 1');
    const s = await add(db, '1002', 'Branch', 'independent');
    expect((await rows<{ show_on_parent_page: boolean }>(db, ADMIN, `select show_on_parent_page from public.campaigns where id = $1`, [t]))[0].show_on_parent_page).toBe(false);
    expect((await page(db, '1002')).teams).toEqual([]);
    await sql(db, `select public.set_team_on_parent_page($1, true)`, [t]);
    expect((await page(db, '1002')).teams).toEqual([{ id: t, name: 'Table 1' }]);
    await expect(sql(db, `select public.set_team_on_parent_page($1, true)`, [s])).rejects.toThrow(/Only teams/);
    await sql(db, `update public.campaigns set status = 'archived' where id = $1`, [t]);
    expect((await page(db, '1002')).teams).toEqual([]);
  });

  it('let only admins and the parent primary fundraiser change the setting', async () => {
    const t = await add(db, '1002', 'Table 1');
    await expect(sql(db, `select public.set_team_on_parent_page($1, true)`, [t], MANAGER_1)).rejects.toThrow(/Only an admin/);
    await sql(db, `select public.set_team_on_parent_page($1, true)`, [t], MANAGER_2);
    await expect(sql(db, `select public.next_child_campaign_id(public.current_org_id(), '1002')`, [], MANAGER_2)).rejects.toThrow();
  });
});
