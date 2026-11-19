import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, MANAGER_1, OIZER, rows, seededDb } from './harness';

// Shulim, 2026-11-17: an admin maps an unrecognized incoming method name to an existing method. Incoming gifts use it
// automatically, gifts on file with that name move (fees kept), and the Task Sheet can do it in place.
// 2026-11-19: saving no longer moves the gifts itself (a large alias timed out); they move in batches.
const q = <T = Record<string, any>>(db: PGlite, sql: string, params: unknown[] = [], who = ADMIN) => rows<T>(db, who, sql, params, OIZER);
const gift = (db: PGlite, id: string, method: string, extra = '') => db.query(
  `insert into public.donations (org_id, id, campaign_id, type, status, amount, payment_method${extra ? ', gateway_id' : ''})
   values ($1, $2, '1001', 'Payment', 'completed', 100, $3${extra ? `, '${extra}'` : ''})`, [OIZER, id, method]);
const row = async (db: PGlite, id: string) =>
  (await db.query<Record<string, any>>(`select payment_method, payment_method_received, fee::float fee from public.donations where id = $1`, [id])).rows[0];
/** Maps a name the way the Task Sheet does, then runs the batches until done, as the app does. */
async function map(db: PGlite, alias: string, method: string, batch = 400) {
  const [{ alias_id, to_move }] = await q<{ alias_id: string; to_move: number }>(db, `select * from public.map_payment_method($1, $2)`, [alias, method]);
  let moved = 0;
  for (let i = 0; i < 1000; i++) {
    const [r] = await q<{ moved: number; remaining: number; done: boolean }>(db, `select * from public.move_alias_gifts($1, $2)`, [alias_id, batch]);
    moved += r.moved;
    if (r.done) break;
  }
  return { alias_id, to_move, moved };
}

describe('payment method aliases, live', () => {
  let base: PGlite;
  let db: PGlite;
  beforeAll(async () => { base = await seededDb(); });
  beforeEach(async () => { db = await base.clone(); });

  it('moves gifts on file to the method, keeping their fee, and maps later ones as they come in', async () => {
    await gift(db, 'ml-old', 'VISA via Sola');
    await gift(db, 'ml-proc', 'visa via sola ', 'sola-ref-1');            // a card-processor gift, any capitals
    const feeBefore = (await row(db, 'ml-old')).fee;                        // no rule for that name: no fee
    const { to_move, moved } = await map(db, 'VISA via Sola', 'Credit Card');
    expect(to_move).toBe(2);
    expect(moved).toBe(2);
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

  it('moves a large alias in batches without timing out, with progress, and finishes once', async () => {
    await db.query(`insert into public.donations (org_id, id, campaign_id, type, status, amount, payment_method, fee)
                    select $1, 'big-' || g, '1001', 'Payment', 'completed', 10, 'Credit Card VISA', 0.59 from generate_series(1, 1200) g`, [OIZER]);
    // Saving is instant: it only marks the move.
    await q(db, `insert into public.payment_method_aliases (alias, method_name) values ('Credit Card VISA', 'Credit Card')`);
    const [a] = await q(db, `select id, move_pending, moved_count from public.payment_method_aliases where alias = 'Credit Card VISA'`);
    expect(a).toMatchObject({ move_pending: true, moved_count: 0 });
    const [{ n }] = (await db.query<{ n: number }>(`select count(*)::int n from public.donations where payment_method = 'Credit Card VISA'`)).rows;
    expect(n).toBe(1200);
    // Batches: progress each time, then done.
    const steps: number[] = [];
    for (;;) {
      const [r] = await q<{ moved: number; remaining: number; total_moved: number; done: boolean }>(db, `select * from public.move_alias_gifts($1, 500)`, [a.id]);
      steps.push(r.remaining);
      if (r.done) { expect(r.total_moved).toBe(1200); break; }
    }
    expect(steps).toEqual([700, 200, 0]);
    const [after] = (await db.query<Record<string, any>>(`select count(*) filter (where payment_method = 'Credit Card')::int moved,
      count(*) filter (where fee = 0.59)::int fee_kept from public.donations where id like 'big-%'`)).rows;
    expect(after).toEqual({ moved: 1200, fee_kept: 1200 });
    const [done] = await q(db, `select move_pending, moved_count, move_finished_at is not null finished from public.payment_method_aliases where id = $1`, [a.id]);
    expect(done).toEqual({ move_pending: false, moved_count: 1200, finished: true });
    // Another batch is a no-op.
    const [again] = await q(db, `select * from public.move_alias_gifts($1, 500)`, [a.id]);
    expect(again).toMatchObject({ moved: 0, done: true });
  });

  it('finishes a move left pending through the every-minute job', async () => {
    await db.query(`insert into public.donations (org_id, id, campaign_id, type, status, amount, payment_method)
                    select $1, 'job-' || g, '1001', 'Payment', 'completed', 10, 'usaepay3' from generate_series(1, 30) g`, [OIZER]);
    await q(db, `insert into public.payment_method_aliases (alias, method_name) values ('usaepay3', 'Credit Card')`);
    await db.query(`select public.run_alias_moves()`);
    const [{ n }] = (await db.query<{ n: number }>(`select count(*)::int n from public.donations where id like 'job-%' and payment_method = 'Credit Card'`)).rows;
    expect(n).toBe(30);
  });

  it('clears the Task Sheet item for that name', async () => {
    await gift(db, 'ml-t', 'Zelle-ish');
    await db.query(`select public.refresh_no_fee_rule_tasks($1)`, [OIZER]);
    const open = () => db.query(`select 1 from public.task_items where org_id = $1 and task_key = 'no_fee_rule:zelle-ish' and resolved_at is null`, [OIZER]).then(r => r.rows.length);
    expect(await open()).toBe(1);
    await map(db, 'Zelle-ish', 'Cash');
    expect(await open()).toBe(0);
  });

  it('works the same when saved under Settings', async () => {
    await gift(db, 'ml-s', 'usaepay2');
    await q(db, `insert into public.payment_method_aliases (alias, method_name) values ('usaepay2', 'credit card')`);
    const [a] = await q(db, `select id, method_name, applied_at is not null live, move_pending from public.payment_method_aliases where alias = 'usaepay2'`);
    expect(a).toMatchObject({ method_name: 'Credit Card', live: true, move_pending: true });
    await q(db, `select * from public.move_alias_gifts($1)`, [a.id]);
    expect((await row(db, 'ml-s')).payment_method).toBe('Credit Card');
  });

  it('leaves suggestions that no admin saved alone, and refuses bad mappings and other people', async () => {
    await db.query(`insert into public.payment_method_aliases (org_id, alias, method_name) values ($1, 'Suggested Only', 'Credit Card')`, [OIZER]);
    await gift(db, 'ml-sug', 'Suggested Only');
    expect((await row(db, 'ml-sug')).payment_method).toBe('Suggested Only');
    const [{ id }] = (await db.query<{ id: string }>(`select id from public.payment_method_aliases where alias = 'Suggested Only'`)).rows;
    expect((await q(db, `select * from public.move_alias_gifts($1)`, [id]))[0]).toMatchObject({ moved: 0, done: true });
    await expect(q(db, `select * from public.map_payment_method('Cash', 'Credit Card')`)).rejects.toThrow(/already one of your payment methods/);
    await expect(q(db, `select * from public.map_payment_method('Odd', 'No Such Method')`)).rejects.toThrow(/Choose one of your payment methods/);
    await expect(q(db, `select * from public.map_payment_method('Odd', 'Cash')`, [], MANAGER_1)).rejects.toThrow(/Only an admin/);
    await expect(q(db, `select * from public.move_alias_gifts($1)`, [id], MANAGER_1)).rejects.toThrow(/Only an admin/);
  });
});
