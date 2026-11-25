import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, MANAGER_1, MANAGER_2, OIZER, rows, seededDb } from './harness';

// A campaign's statement with the running balance after each transaction (Shulim, 2026-11-25). Sample data only.
type Line = { kind: string; id: string; campaign_id: string; description: string; money_in: string; fee: string; money_out: string; change: string; balance: string };
const q = <T = Record<string, any>>(db: PGlite, sql: string, params: unknown[] = [], who = ADMIN) => rows<T>(db, who, sql, params, OIZER);
const statement = (db: PGlite, id: string, who = ADMIN) => q<Line>(db, 'select * from public.campaign_statement($1)', [id], who);
const shownBalance = async (db: PGlite, id: string) => Number((await q<{ balance: string }>(db, 'select balance from public.campaign_summary where id = $1', [id]))[0].balance);
const last = (l: Line[]) => Number(l[l.length - 1]?.balance ?? 0);

describe('campaign statement', () => {
  let base: PGlite;
  let db: PGlite;
  beforeAll(async () => { base = await seededDb(); });
  beforeEach(async () => { db = await base.clone(); });

  it('lists gifts, fees, payouts and transfers in date order, ending on the balance the campaign shows', async () => {
    const l = await statement(db, '1001');
    expect(l.length).toBeGreaterThan(0);
    // Each line's balance is the one before plus its change.
    l.reduce((prev, x) => { expect(Number(x.balance)).toBeCloseTo(prev + Number(x.change), 2); return Number(x.balance); }, 0);
    expect(last(l)).toBeCloseTo(await shownBalance(db, '1001'), 2);
    expect(l.map(x => x.kind)).toEqual(expect.arrayContaining(['donation', 'payout', 'transfer_out']));
    expect((await statement(db, '1002')).map(x => x.kind)).toContain('transfer_in');
    expect(last(await statement(db, '1002'))).toBeCloseTo(await shownBalance(db, '1002'), 2);
  });

  it('leaves out gifts that move no money, and counts a refunded gift\'s fee as the balance does', async () => {
    await q(db, `insert into public.donations (campaign_id, donor_id, amount, type, status, payment_method, donary_id) values
      ('1001', 'd1', 70, 'Payment', 'completed', 'Cash', 'DN-ST-1')`);   // held Donary cash
    await q(db, `insert into public.donations (id, campaign_id, donor_id, amount, type, status, payment_method, post_dated, check_date) values
      ('pd-1', '1001', 'd1', 90, 'Payment', 'completed', 'Check', true, current_date + 30)`);   // post-dated
    const l = await statement(db, '1001');
    expect(l.find(x => x.description.includes('Held') || x.id === 'pd-1')).toBeUndefined();
    expect(last(l)).toBeCloseTo(await shownBalance(db, '1001'), 2);
    await q(db, `update public.donations set status = 'refunded' where id = 'p2'`);
    const r = (await statement(db, '1001')).find(x => x.id === 'p2')!;
    expect([Number(r.money_in), Number(r.fee)]).toEqual([0, 7.56]);
    expect(last(await statement(db, '1001'))).toBeCloseTo(await shownBalance(db, '1001'), 2);
  });

  it('includes teams that share the balance, so it ends on the combined balance', async () => {
    await q(db, `insert into public.campaigns (id, internal_name, manager_id, parent_campaign_id, balance_mode) values ('1001-T', 'Sample Team', 'm1', '1001', 'shared')`);
    await q(db, `insert into public.donations (campaign_id, donor_id, amount, type, status, payment_method) values ('1001-T', 'd2', 55, 'Payment', 'completed', 'Cash')`);
    const l = await statement(db, '1001');
    expect(l.some(x => x.campaign_id === '1001-T')).toBe(true);
    expect(last(l)).toBeCloseTo(await shownBalance(db, '1001'), 2);
  });

  it('is for admins and the campaign\'s own fundraisers; payees only for those who may see them', async () => {
    expect((await statement(db, '1001', MANAGER_1)).length).toBeGreaterThan(0);
    await expect(statement(db, '1001', MANAGER_2)).rejects.toThrow(/isn't yours/);
    const payout = (await statement(db, '1001', MANAGER_1)).find(x => x.kind === 'payout');
    expect(payout).toBeDefined();
  });
});
