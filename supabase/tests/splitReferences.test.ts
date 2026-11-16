import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, OIZER, as, rows, seededDb } from './harness';

// Readiness #22 (2026-11-15): splitting a gift dropped its references from the new parts.
const split = (db: PGlite, id: string, legs: object[]) =>
  as(db, ADMIN, tx => tx.query(`select public.split_donation($1, $2::jsonb) g`, [id, JSON.stringify(legs)]), OIZER);
const parts = async (db: PGlite, group: string) => (await db.query<Record<string, any>>(
  `select id, campaign_id, amount, status, gateway_id, donary_id, batch_id, bank_reference, voucher_id, created_by from public.donations
    where split_group_id = $1 order by amount desc`, [group])).rows;

describe('split gifts keep their references', () => {
  let base: PGlite;
  let db: PGlite;
  beforeAll(async () => { base = await seededDb(); });
  beforeEach(async () => {
    db = await base.clone();
    const [{ id: voucher }] = await rows<{ id: string }>(db, ADMIN,
      `insert into public.vouchers (campaign_id, issuer, face_value, fee_type) values ('1003', 'Voucher — OJC Fund', 1000, 'none') returning id`, [], OIZER);
    await db.query(`insert into public.donations (org_id, id, campaign_id, type, status, amount, manual_fee, payment_method, account_id,
                      gateway_id, donary_id, batch_id, bank_reference, voucher_id, created_by)
                    values ($1, 'sp-1', '1003', 'Payment', 'completed', 100, 0, 'Cash', 'a1', 'GW-77', 'DN-77', 'B-9', 'BANKREF-1', $2, 'entered@example.org')`,
                   [OIZER, voucher]);
  });
  const group = async () => (await db.query<{ g: string }>(`select split_group_id g from public.donations where id = 'sp-1'`)).rows[0].g;

  it('copies every reference onto every part, and the voucher keeps its whole funded total', async () => {
    const [{ v }] = (await db.query<{ v: string }>(`select voucher_id v from public.donations where id = 'sp-1'`)).rows;
    const fundedBefore = (await db.query<{ f: string }>(`select public.voucher_funded($1, $2)::text f`, [OIZER, v])).rows[0].f;
    await split(db, 'sp-1', [{ campaign_id: '1003', amount: 60 }, { campaign_id: '1001', amount: 40 }]);
    const ps = await parts(db, await group());
    expect(ps).toHaveLength(2);
    for (const p of ps) {
      expect(p).toMatchObject({ gateway_id: 'GW-77', donary_id: 'DN-77', batch_id: 'B-9', bank_reference: 'BANKREF-1', voucher_id: v, created_by: 'entered@example.org' });
    }
    expect((await db.query<{ f: string }>(`select public.voucher_funded($1, $2)::text f`, [OIZER, v])).rows[0].f).toBe(fundedBefore);
  });

  it('shows a split gift as one item for bank matching', async () => {
    await split(db, 'sp-1', [{ campaign_id: '1003', amount: 60 }, { campaign_id: '1001', amount: 40 }]);
    const g = await group();
    const items = (await db.query<Record<string, any>>(`select item_type, item_id, amount::text, description from public.recon_book_items($1, 'a1')
                                                          where item_id = $2 or item_id in (select id from public.donations where split_group_id = $2)`, [OIZER, g])).rows;
    expect(items).toEqual([expect.objectContaining({ item_type: 'donation_split', item_id: g, amount: '100.00' })]);
    expect(items[0].description).toMatch(/split across 2 campaigns/);
    // Set aside as one item.
    await as(db, ADMIN, tx => tx.query(`select public.exclude_book_item('donation_split', $1, 'Deposited elsewhere')`, [g]), OIZER);
    const [x] = (await db.query<{ excluded: boolean }>(`select excluded from public.recon_book_items($1, 'a1') where item_id = $2`, [OIZER, g])).rows;
    expect(x.excluded).toBe(true);
  });

  it('reverses every part when the processor voids or fully refunds a split gift', async () => {
    await split(db, 'sp-1', [{ campaign_id: '1003', amount: 60 }, { campaign_id: '1001', amount: 40 }]);
    const g = await group();
    await db.query(`select public.make_void($1, null, 'GW-77', 'Voided at Sola (test)')`, [OIZER]);
    expect((await parts(db, g)).map(p => p.status)).toEqual(['voided', 'voided']);
  });

  it('refunds every part for a full processor refund', async () => {
    await split(db, 'sp-1', [{ campaign_id: '1003', amount: 60 }, { campaign_id: '1001', amount: 40 }]);
    const g = await group();
    await db.query(`select public.make_refund($1, null, 'GW-77', 100, '2026-11-12 10:00', 'Refunded (test)')`, [OIZER]);
    expect((await parts(db, g)).map(p => p.status)).toEqual(['refunded', 'refunded']);
  });
});

// Readiness #28 (2026-11-15): a check not delivered yet isn't offered for bank matching until it's delivered.
describe('checks not delivered yet', () => {
  it("stay off the books side of bank matching until they're delivered", async () => {
    const db = await seededDb();
    await db.query(`insert into public.donations (org_id, id, campaign_id, type, status, amount, manual_fee, payment_method, account_id, delivered)
                    values ($1, 'ud-1', '1003', 'Payment', 'completed', 250, 0, 'Check', 'a1', false)`, [OIZER]);
    const offered = async () => (await db.query(`select item_id from public.recon_book_items($1, 'a1') where item_id = 'ud-1'`, [OIZER])).rows.length;
    expect(await offered()).toBe(0);
    await db.query(`update public.donations set delivered = true where id = 'ud-1'`);
    expect(await offered()).toBe(1);
  });
});

// Readiness #31 (2026-11-15): a completed gift always has a bank account.
describe('bank account on completed gifts', () => {
  it('routes one, and puts a gift with nowhere else to go in the Clearing account, which the books check lists', async () => {
    const db = await seededDb();
    await db.query(`insert into public.settings (org_id, key, value) values ($1, 'default_account_id', '"a1"')`, [OIZER]);
    await db.query(`insert into public.donations (org_id, id, campaign_id, type, status, amount, manual_fee, payment_method) values ($1, 'ac-1', '1003', 'Payment', 'completed', 10, 0, 'Cash')`, [OIZER]);
    const acct = async (id: string) => (await db.query<{ a: string | null; name: string | null }>(
      `select d.account_id a, x.name from public.donations d left join public.accounts x on x.org_id = d.org_id and x.id = d.account_id where d.id = $1`, [id])).rows[0];
    expect((await acct('ac-1')).a).toBe('a1');
    // No default, campaign or method account: the Clearing account, and the books check counts it.
    await db.query(`delete from public.settings where key = 'default_account_id'`);
    const before = Number((await db.query<{ n: number }>(`select n from public.integrity_checks($1) where check_key = 'no_account'`, [OIZER])).rows[0].n);
    await db.query(`insert into public.donations (org_id, id, campaign_id, type, status, amount, manual_fee, payment_method) values ($1, 'ac-2', '1003', 'Payment', 'completed', 10, 0, 'Cash')`, [OIZER]);
    expect((await acct('ac-2')).name).toBe('Clearing (unassigned)');
    const after = Number((await db.query<{ n: number }>(`select n from public.integrity_checks($1) where check_key = 'no_account'`, [OIZER])).rows[0].n);
    expect(after - before).toBe(1);
    // One Clearing account per organization, reused.
    await db.query(`insert into public.donations (org_id, id, campaign_id, type, status, amount, manual_fee, payment_method) values ($1, 'ac-3', '1003', 'Payment', 'completed', 10, 0, 'Cash')`, [OIZER]);
    expect((await acct('ac-3')).a).toBe((await acct('ac-2')).a);
    // Nothing completed is left without one.
    const [{ n }] = (await db.query<{ n: number }>(`select count(*)::int n from public.donations where status = 'completed' and account_id is null and id like 'ac-%'`)).rows;
    expect(n).toBe(0);
  });
});
