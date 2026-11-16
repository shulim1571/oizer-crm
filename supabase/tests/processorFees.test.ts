import type { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { ADMIN, OIZER, rows, seededDb } from './harness';

// Readiness #14 (2026-11-15): an unknown payment method meant no fee, silently, and every card processor got the
// same "Credit Card" rate.
async function setup() {
  const db = await seededDb();
  await db.query(`update public.org_members set role = 'super_admin' where user_id = $1`, [ADMIN]);
  await db.query(`insert into public.sources (org_id, id, name) values ($1, 'Cartis', 'Cartis'), ($1, 'Sola', 'Sola'), ($1, 'Online', 'Online'), ($1, 'Manual', 'Manual') on conflict do nothing`, [OIZER]);
  await db.query(`update public.payment_methods set fee_type = 'percent_flat', fee_percent = 2.55, fee_flat = 0.18 where org_id = $1 and name = 'Credit Card'`, [OIZER]);
  const [{ id: card }] = (await db.query<{ id: string }>(`select id from public.payment_methods where org_id = $1 and name = 'Credit Card'`, [OIZER])).rows;
  return { db, card };
}
const gift = async (db: PGlite, id: string, source: string, extra = '', vals = '') =>
  (await db.query<{ fee: string }>(`insert into public.donations (org_id, id, campaign_id, type, status, amount, payment_method, source${extra})
                                    values ($1, $2, '1001', 'Payment', 'completed', 100, 'Credit Card', $3${vals}) returning fee`, [OIZER, id, source])).rows[0].fee;
const tasks = async (db: PGlite) => (await db.query<{ task_key: string; summary: string; amount: string }>(
  `select task_key, summary, amount::text from public.task_items where org_id = $1 and task_type = 'no_fee_rule' and resolved_at is null order by task_key`, [OIZER])).rows;

describe('fees per processor', () => {
  it('gives a Sola card gift and an Elevon card gift their own rates, the method rate otherwise', async () => {
    const { db, card } = await setup();
    await rows(db, ADMIN, `insert into public.processor_fee_rules (processor, method_id, fee_type, fee_percent, fee_flat) values ('elevon', $1, 'percent_flat', 2.9, 0.30)`, [card], OIZER);
    await rows(db, ADMIN, `insert into public.processor_fee_rules (processor, method_id, fee_type, fee_percent, fee_flat) values ('sola', $1, 'percent', 2.0, 0)`, [card], OIZER);
    expect(await gift(db, 'pf-elevon', 'Cartis', ', gateway_id', `, 'E-1'`)).toBe('3.20');      // 2.9% + 0.30
    expect(await gift(db, 'pf-sola', 'Sola', ', gateway_id', `, 'S-1'`)).toBe('2.00');          // 2%
    expect(await gift(db, 'pf-app', 'Online', ', gateway_id', `, 'S-2'`)).toBe('2.00');         // a card taken in the app goes through Sola
    expect(await gift(db, 'pf-hand', 'Manual')).toBe('2.73');                                   // no processor: the method's 2.55% + 0.18
  });

  it("still puts a campaign's own fee deal first", async () => {
    const { db, card } = await setup();
    await rows(db, ADMIN, `insert into public.processor_fee_rules (processor, method_id, fee_type, fee_percent, fee_flat) values ('elevon', $1, 'percent_flat', 2.9, 0.30)`, [card], OIZER);
    await rows(db, ADMIN, `insert into public.campaign_fee_overrides (campaign_id, method_id, fee_type, fee_flat) values ('1001', $1, 'flat', 1)`, [card], OIZER);
    expect(await gift(db, 'pf-ovr', 'Cartis', ', gateway_id', `, 'E-2'`)).toBe('1.00');
  });

  it('keeps the real fee an Elevon feed sends', async () => {
    const { db } = await setup();
    const [{ k }] = await rows<{ k: string }>(db, ADMIN, `select public.make_ingest_new_secret() k`);
    await rows(db, ADMIN, `select public.make_ingest_set_enabled(true)`);
    const [{ r }] = (await db.query<{ r: any }>(`select public.make_ingest($1, $2, 'elevon', $3::jsonb) r`, [OIZER, k, JSON.stringify({
      amount: '100', payment_status: 'succeeded', fee: '3.47', name: 'Sample Donor', payment_info: { referenceId: 'EL-FEE-1' }, created_at: '2026-11-12T15:00:00Z' })])).rows;
    expect(r.outcome).toBe('created');
    const [d] = (await db.query<{ fee: string; net_donation: string }>(`select fee, net_donation from public.donations where id = $1`, [r.record_id])).rows;
    expect(d).toEqual({ fee: '3.47', net_donation: '96.53' });
  });
});

describe('gifts with no fee rule', () => {
  it('are flagged on the Task Sheet, one item per method, and the item clears once the method is added', async () => {
    const { db } = await setup();
    const add = (id: string, method: string | null) => db.query(
      `insert into public.donations (org_id, id, campaign_id, type, status, amount, payment_method) values ($1, $2, '1001', 'Payment', 'completed', 40, $3)`, [OIZER, id, method]);
    await add('nf-1', 'Venmo');
    await add('nf-2', 'venmo');
    await add('nf-3', null);
    await add('nf-ok', 'Cash');   // a listed method: its fee (none) is worked out, nothing to flag
    const open = await tasks(db);
    expect(open.find(t => t.task_key === 'no_fee_rule:venmo')).toMatchObject({ amount: '80.00' });
    expect(open.find(t => t.task_key === 'no_fee_rule:venmo')?.summary).toMatch(/"Venmo" has no fee rule: 2 completed gifts/);
    expect(open.find(t => t.task_key === 'no_fee_rule:')?.summary).toMatch(/1 completed gift with no payment method/);
    expect(open.some(t => /cash/i.test(t.task_key))).toBe(false);
    // Shows on the Task Sheet the admin sees.
    const sheet = await rows<{ task_type: string }>(db, ADMIN, `select task_type from public.admin_task_sheet where task_type = 'no_fee_rule'`, [], OIZER);
    expect(sheet.length).toBeGreaterThanOrEqual(2);
    // Adding the method clears its item.
    await rows(db, ADMIN, `insert into public.payment_methods (name, category, fee_type, fee_percent) values ('Venmo', 'Manual', 'percent', 1.9)`, [], OIZER);
    expect((await tasks(db)).map(t => t.task_key)).toEqual(['no_fee_rule:']);
  });
});
