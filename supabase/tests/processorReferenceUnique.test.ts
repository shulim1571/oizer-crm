import type { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { ADMIN, OIZER, rows, seededDb } from './harness';

// Readiness #23 (2026-11-15): one live gift per processor reference, and a delivery that hits it is a duplicate.
const add = (db: PGlite, id: string, gw: string | null, dn: string | null = null, extra = '') =>
  db.query(`insert into public.donations (org_id, id, campaign_id, type, status, amount, manual_fee, payment_method, gateway_id, donary_id${extra ? ', split_group_id' : ''})
            values ($1, $2, '1001', 'Payment', 'completed', 10, 0, 'Cash', $3, $4${extra ? `, '${extra}'` : ''})`, [OIZER, id, gw, dn]);

async function ingestSetup() {
  const db = await seededDb();
  await db.query(`update public.org_members set role = 'super_admin' where user_id = $1`, [ADMIN]);
  const [{ k }] = await rows<{ k: string }>(db, ADMIN, `select public.make_ingest_new_secret() k`);
  await rows(db, ADMIN, `select public.make_ingest_set_enabled(true)`);
  const ingest = async (source: string, body: unknown) =>
    (await db.query<{ r: any }>(`select public.make_ingest($1, $2, $3, $4::jsonb) r`, [OIZER, k, source, JSON.stringify(body)])).rows[0].r;
  return { db, ingest };
}

describe('processor references are recorded once', () => {
  it('refuses a second live gift with the same gateway reference or Donary payment number', async () => {
    const db = await seededDb();
    await add(db, 'u-1', 'GW-1');
    await expect(add(db, 'u-2', 'GW-1')).rejects.toThrow(/donations_gateway_once/);
    await add(db, 'u-3', null, 'DN-1');
    await expect(add(db, 'u-4', null, 'DN-1')).rejects.toThrow(/donations_donary_once/);
    // A failed attempt, a deleted gift, split parts and imported history don't count.
    await db.query(`update public.donations set status = 'failed' where id = 'u-1'`);
    await add(db, 'u-5', 'GW-1');
    await add(db, 'sp-a', 'GW-9', null, 'grp1');
    await add(db, 'sp-b', 'GW-9', null, 'grp1');
    await add(db, 'AS-old1', 'GW-IMP');
    await add(db, 'AS-old2', 'GW-IMP');
  });

  it('answers a second delivery of the same Sola sale as a duplicate, even when both arrive at once', async () => {
    const { db, ingest } = await ingestSetup();
    const sale = { xCommand: 'cc:sale', xRefNum: 'RACE-1', xAmount: '25', xResponseResult: 'Approved', xEnteredDate: '2026-11-12 10:00:00' };
    expect((await ingest('sola', sale)).outcome).toBe('created');
    // Two at once: the second doesn't see the first when it looks (simulated), and the database stops it.
    await db.exec(`create or replace function public.make_existing(p_org uuid, p_payment text, p_gateway text) returns text language sql as $$ select null::text $$`);
    const again = await ingest('sola', sale);
    expect(again).toMatchObject({ ok: true, outcome: 'duplicate' });
    const [{ n }] = (await db.query<{ n: number }>(`select count(*)::int n from public.donations where gateway_id = 'RACE-1'`)).rows;
    expect(n).toBe(1);
    const [log] = (await db.query<{ outcome: string }>(`select outcome from public.make_ingest_log order by id desc limit 1`)).rows;
    expect(log.outcome).toBe('duplicate');
  });
});
