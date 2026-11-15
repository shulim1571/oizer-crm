import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, MANAGER_1, rows, seededDb } from './harness';

// Moshe Henig, 2026-11-15: the New Campaign form suggests the next ID; the admin may change it; IDs stay unique.
const insert = (db: PGlite, id: string | null, name = 'Sample') =>
  rows(db, ADMIN, `insert into public.campaigns (id, internal_name, status) values ($1, $2, 'active') returning id`, [id, name]).then(r => r[0].id as string);

describe('campaign IDs on the New Campaign form', () => {
  let base: PGlite;
  let db: PGlite;
  beforeAll(async () => { base = await seededDb(); });
  beforeEach(async () => { db = await base.clone(); });

  it('suggests the next number, which an empty box also gets', async () => {
    const [{ n }] = await rows(db, ADMIN, `select public.next_campaign_id() as n`);
    expect(await insert(db, n)).toBe(n);
    expect(await insert(db, '')).toBe(String(Number(n) + 1));
    expect((await rows(db, MANAGER_1, `select public.next_campaign_id() as n`))[0].n).toBeNull();
  });

  it('takes an edited ID, trimmed, and refuses one already used (any capitals) or with other characters', async () => {
    expect(await insert(db, ' Spring-26 ')).toBe('Spring-26');
    await expect(insert(db, 'SPRING-26')).rejects.toThrow(/already taken/);
    await expect(insert(db, '1001')).rejects.toThrow(/already taken/);
    for (const bad of ['two words', 'a/b', '-x', 'x'.repeat(41)]) await expect(insert(db, bad)).rejects.toThrow(/letters, numbers and dashes/);
  });

  it('keeps IDs permanent after creation', async () => {
    await expect(rows(db, ADMIN, `update public.campaigns set id = 'NEW-1' where id = '1001'`)).rejects.toThrow(/permanent/);
  });
});
