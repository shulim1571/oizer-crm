import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, OIZER, rows, seededDb } from './harness';

// Moshe, Nov 16: donors have a Cell phone and a Home phone. Numbers on file are split (labels first; unlabeled:
// first to Cell, second to Home; one number to Cell). Phone stays, holding "cell, home". Texts go to Cell.
const q = <T = Record<string, any>>(db: PGlite, sql: string, params: unknown[] = []) => rows<T>(db, ADMIN, sql, params, OIZER);
const split = async (db: PGlite, p: string | null) => (await db.query<{ cell: string | null; home: string | null }>(`select * from public.split_phones($1)`, [p])).rows[0];

describe('home and cell phones', () => {
  let base: PGlite;
  let db: PGlite;
  beforeAll(async () => { base = await seededDb(); });
  beforeEach(async () => { db = await base.clone(); });

  it('splits the numbers on file sensibly', async () => {
    expect(await split(db, '8455551234, 7185559999')).toEqual({ cell: '8455551234', home: '7185559999' });
    expect(await split(db, '8455551234,7185559999')).toEqual({ cell: '8455551234', home: '7185559999' });
    expect(await split(db, '8455551234: 7185559999')).toEqual({ cell: '8455551234', home: '7185559999' });
    expect(await split(db, 'H 845-555-1234, C 718-555-9999')).toEqual({ cell: '718-555-9999', home: '845-555-1234' });
    expect(await split(db, 'Home: (845) 555-1234 / Cell: 718.555.9999')).toEqual({ cell: '718.555.9999', home: '(845) 555-1234' });
    expect(await split(db, '845-555-1234 (home), 718-555-9999')).toEqual({ cell: '718-555-9999', home: '845-555-1234' });
    expect(await split(db, 'mobile 7185559999')).toEqual({ cell: '7185559999', home: null });
    expect(await split(db, '845-555-1234')).toEqual({ cell: '845-555-1234', home: null });
    expect(await split(db, 'ask office')).toEqual({ cell: 'ask office', home: null });
    expect(await split(db, '  ')).toEqual({ cell: null, home: null });
  });

  it('keeps Phone and the two boxes in step', async () => {
    const [d] = await q(db, `insert into public.donors (first_name, last_name, phone) values ('Test', 'Phones', '8455551234, 7185559999') returning id, cell_phone, home_phone, phone`);
    expect(d).toMatchObject({ cell_phone: '8455551234', home_phone: '7185559999', phone: '8455551234, 7185559999' });
    const [e] = await q(db, `update public.donors set home_phone = '9145550000' where id = $1 returning cell_phone, home_phone, phone`, [d.id]);
    expect(e).toMatchObject({ cell_phone: '8455551234', home_phone: '9145550000', phone: '8455551234, 9145550000' });
    const [f] = await q(db, `update public.donors set cell_phone = null where id = $1 returning cell_phone, home_phone, phone`, [d.id]);
    expect(f).toMatchObject({ cell_phone: null, home_phone: '9145550000', phone: '9145550000' });
    const [g] = await q(db, `update public.donors set phone = 'C 3475551111' where id = $1 returning cell_phone, home_phone`, [d.id]);
    expect(g).toMatchObject({ cell_phone: '3475551111', home_phone: null });
    const [h] = await q(db, `insert into public.donors (first_name, cell_phone, home_phone) values ('Boxes', '3475552222', '8455553333') returning phone`);
    expect(h.phone).toBe('3475552222, 8455553333');
    const [s] = await q(db, `select cell_phone, home_phone from public.donor_summary where id = $1`, [d.id]);
    expect(s).toEqual({ cell_phone: '3475551111', home_phone: null });
  });

  it('texts a donor at the cell number', async () => {
    const [d] = await q(db, `insert into public.donors (first_name, last_name, phone, email) values ('Text', 'Me', '8455551234, 7185559999', null) returning id`);
    const got = await q(db, `select phone from public.outreach_group('all_donors', null) where id = $1`, [d.id]);
    expect(got[0]?.phone).toBe('8455551234');
    const defs = await db.query<{ def: string }>(`select pg_get_functiondef(p.oid) def from pg_proc p where p.proname in ('send_outreach', 'fundraiser_request_receipt', 'outreach_group')`);
    for (const r of defs.rows) expect(r.def).toContain('cell_phone');
  });

  it('moved the seeded numbers over', async () => {
    const [{ n }] = await q(db, `select count(*)::int n from public.donors where nullif(trim(phone), '') is not null and cell_phone is null and home_phone is null`);
    expect(n).toBe(0);
  });
});
