import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, MANAGER_1, OIZER, rows, seededDb } from './harness';

// Shulim, 2026-11-17: an admin maps an unrecognized incoming method name to an existing method. Incoming gifts use it
// automatically, gifts on file with that name move (fees kept), and the Task Sheet can do it in place.
const q = <T = Record<string, any>>(db: PGlite, sql: string, params: unknown[] = [], who = ADMIN) => rows<T>(db, who, sql, params, OIZER);
const gift = (db: PGlite, id: string, method: string, extra = '') => db.query(
  `insert into public.donations (org_id, id, campaign_id, type, status, amount, payment_method${extra ? ', gateway_id' : ''})
   values ($1, $2, '1001', 'Payment', 'completed', 100, $3${extra ? `, '${extra}'` : ''})`, [OIZER, id, method]);
const row = async (db: PGlite, id: string) =>
  (await db.query<Record<string, any>>(`select payment_method, payment_method_received, fee::float fee from public.donations where id = $1`, [id])).rows[0];

describe('payment method aliases, live', () => {
  let base: PGlite;
  let db: PGlite;
  beforeAll(async () => { base = await seededDb(); });
  beforeEach(async () => { db = await base.clone(); });

  it('moves gifts on file to the method, keeping their fee, and maps later ones as they come in', async () => {
    await gift(db, 'ml-old', 'VISA via Sola');
    await gift(db, 'ml-proc', 'visa via sola ', 'sola-ref-1');            // a card-processor gift, any capitals
    const feeBefore = (await row(db, 'ml-old')).fee;                        // no rule for that name: no fee
    const [{ n }] = await q<{ n: number }>(db, `select public.map_payment_method('VISA via Sola', 'Credit Card') n`);
    expect(n).toBe(2);
    expect(await row(db, 'ml-old')).toEqual({ payment_method: 'Credit Card', payment_method_received: 'VISA via Sola', fee: feeBefore });   // fee kept
    expect((await row(db, 'ml-proc')).payment_method).toBe('Credit Card');
    // Coming in later (a webhook or import): saved under the method, with the method's fee rule.
    await gift(db, 'ml-new', 'VISA via Sola');
    const later = await row(db, 'ml-new');
    expect(later.payment_method).toBe('Credit Card');
    expect(later.payment_method_received).toBe('VISA via Sola');
    const [{ f }] = (await db.query<{ f: number }>(`select public.calculate_fee($1, '1001', 'Credit Card', 100, null)::float f`, [OIZER])).rows;
    expect(later.fee).toBeCloseTo(f, 2);
  });

  it('clears the Task Sheet item for that name', async () => {
    await gift(db, 'ml-t', 'Zelle-ish');
    await db.query(`select public.refresh_no_fee_rule_tasks($1)`, [OIZER]);
    const open = () => db.query(`select 1 from public.task_items where org_id = $1 and task_key = 'no_fee_rule:zelle-ish' and resolved_at is null`, [OIZER]).then(r => r.rows.length);
    expect(await open()).toBe(1);
    await q(db, `select public.map_payment_method('Zelle-ish', 'Cash')`);
    expect(await open()).toBe(0);
  });

  it('works the same when saved under Settings', async () => {
    await gift(db, 'ml-s', 'usaepay2');
    await q(db, `insert into public.payment_method_aliases (alias, method_name) values ('usaepay2', 'credit card')`);
    expect((await row(db, 'ml-s')).payment_method).toBe('Credit Card');
    const [a] = await q(db, `select method_name, applied_at is not null live from public.payment_method_aliases where alias = 'usaepay2'`);
    expect(a).toEqual({ method_name: 'Credit Card', live: true });
  });

  it('leaves suggestions that no admin saved alone, and refuses bad mappings', async () => {
    await db.query(`insert into public.payment_method_aliases (org_id, alias, method_name) values ($1, 'Suggested Only', 'Credit Card')`, [OIZER]);
    await gift(db, 'ml-sug', 'Suggested Only');
    expect((await row(db, 'ml-sug')).payment_method).toBe('Suggested Only');
    await expect(q(db, `select public.map_payment_method('Cash', 'Credit Card')`)).rejects.toThrow(/already one of your payment methods/);
    await expect(q(db, `select public.map_payment_method('Odd', 'No Such Method')`)).rejects.toThrow(/Choose one of your payment methods/);
    await expect(q(db, `select public.map_payment_method('Odd', 'Cash')`, [], MANAGER_1)).rejects.toThrow(/Only an admin/);
  });
});
