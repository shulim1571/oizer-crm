import { describe, expect, it } from 'vitest';
import { ADMIN, OIZER, as, rows, seededDb } from './harness';

// Moshe Henig, 2026-11-11: an edited campaign name shows on its payment page right away.
const name = async (db: Awaited<ReturnType<typeof seededDb>>, id: string) =>
  (await rows<{ n: string }>(db, 'anon', `select public.public_give_page($1, $2) -> 'campaign' ->> 'name' n`, [OIZER, id]))[0].n;
const sql = (db: Awaited<ReturnType<typeof seededDb>>, q: string, p: unknown[] = []) => as(db, ADMIN, tx => tx.query(q, p));

describe('campaign name on the payment page', () => {
  it('follows a rename when the external name was only a copy of the internal name', async () => {
    const db = await seededDb();
    const [c] = await rows<{ id: string; external_name: string }>(db, ADMIN, `insert into public.campaigns (internal_name, status) values ('Schwartsz Shoes', 'active') returning id, external_name`);
    expect(c.external_name).toBe('Schwartsz Shoes');
    await sql(db, `update public.campaigns set internal_name = 'Schwartz Shoes' where id = $1`, [c.id]);
    expect(await name(db, c.id)).toBe('Schwartz Shoes');
  });

  it('keeps an external name set on purpose, and falls back to the internal name when it is emptied', async () => {
    const db = await seededDb();
    const [c] = await rows<{ id: string }>(db, ADMIN, `insert into public.campaigns (internal_name, external_name, status) values ('Office name', 'Donor name', 'active') returning id`);
    await sql(db, `update public.campaigns set internal_name = 'Office name 2' where id = $1`, [c.id]);
    expect(await name(db, c.id)).toBe('Donor name');
    await sql(db, `update public.campaigns set external_name = '' where id = $1`, [c.id]);
    expect(await name(db, c.id)).toBe('Office name 2');
    await sql(db, `update public.campaigns set external_name = 'New donor name' where id = $1`, [c.id]);
    expect(await name(db, c.id)).toBe('New donor name');
  });
});
