import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, MANAGER_1, OIZER, rows, seededDb } from './harness';

// Reconciliation from the inbox (Shulim, 2026-11-19). All sample data: no real donors, certificates or accounts.
// Readers store deposits with suggested matches; a person decides each line and confirms. Nothing posts before that.
const q = <T = Record<string, any>>(db: PGlite, sql: string, params: unknown[] = [], who = ADMIN) => rows<T>(db, who, sql, params, OIZER);
const record = async (db: PGlite, p: unknown) =>
  (await db.query<{ id: string }>(`select public.inbox_record_deposit($1, null, $2::jsonb) id`, [OIZER, JSON.stringify(p)])).rows[0].id;
const lines = (db: PGlite, dep: string) => q(db, `select * from public.deposit_lines where deposit_id = $1 order by line_no`, [dep]);
const count = async (db: PGlite, sql: string) => (await db.query<{ n: number }>(sql)).rows[0].n;

describe('reconciliation items', () => {
  let base: PGlite;
  let db: PGlite;
  beforeAll(async () => {
    base = await seededDb();
    await base.exec(`update public.org_members set role = 'super_admin' where user_id = '${ADMIN}';`);
  });
  beforeEach(async () => { db = await base.clone(); });

  it('keeps the card last 4 from the feeds, never more', async () => {
    const [{ k }] = await q<{ k: string }>(db, `select public.make_ingest_new_secret() k`);
    await q(db, `select public.make_ingest_set_enabled(true)`);
    const make = async (source: string, body: unknown) =>
      (await db.query<{ r: any }>(`select public.make_ingest($1, $2, $3, $4::jsonb) r`, [OIZER, k, source, JSON.stringify(body)])).rows[0].r;
    const d = await make('donary-payment', { amount: 18, paymentNumber: 'S-1', gatewayRefNum: 'G-S1', last4Digits: '4242', campaignInfo: [{ campaignNumber: '1001' }], donorInfo: { firstName: 'Sample' } });
    const s = await make('sola', { xCustom02: '1001', xBillFirstName: 'A', xBillLastName: 'B', xAmount: '10', xCommand: 'cc:sale', xResponseResult: 'Approved', xRefNum: 'R-S1', xMaskedCardNumber: '4xxxxxxxxxxx1111' });
    const e = await make('elevon', { external_campaign_id: '1003', name: 'E', amount: 7, payment_method: 'Credit Card', payment_status: 'succeeded', payment_info: { referenceId: 'E-S1', card_number: '************5555' } });
    const last4 = async (id: string) => (await db.query<{ c: string | null }>(`select card_last4 c from public.donations where id = $1`, [id])).rows[0].c;
    expect([await last4(d.record_id), await last4(s.record_id), await last4(e.record_id)]).toEqual(['4242', '1111', '5555']);
    await expect(db.query(`update public.donations set card_last4 = '4111111111111111' where id = $1`, [d.record_id])).rejects.toThrow();
  });

  it('groups checks on a deposit slip, and a bank check-deposit notice suggests that slip', async () => {
    await db.query(`insert into public.donations (org_id, id, campaign_id, type, status, amount, payment_method, created_at) values
      ($1, 'ck-1', '1001', 'Payment', 'completed', 150, 'Check', now()), ($1, 'ck-2', '1001', 'Payment', 'completed', 250, 'Check', now()),
      ($1, 'cs-1', '1001', 'Payment', 'completed', 20, 'Cash', now())`, [OIZER]);
    await expect(q(db, `select public.make_deposit_slip(array['ck-1', 'cs-1'])`)).rejects.toThrow(/Only checks/);
    const [{ id: slip }] = await q<{ id: string }>(db, `select public.make_deposit_slip(array['ck-1', 'ck-2']) id`);
    expect((await q(db, `select total, check_count, status from public.deposit_slips where id = $1`, [slip]))[0]).toEqual({ total: '400.00', check_count: 2, status: 'open' });
    await expect(q(db, `select public.make_deposit_slip(array['ck-1'])`)).rejects.toThrow(/already on a slip|Only checks/);
    const today = (await db.query<{ d: string }>(`select public.org_today()::text d`)).rows[0].d;
    const dep = await record(db, { kind: 'bank_check_deposit', issuer: 'Chase', deposit_date: today, net: 400, account_last4: '0000', lines: [] });
    expect((await q(db, `select suggested_slip, status from public.deposits where id = $1`, [dep]))[0]).toEqual({ suggested_slip: slip, status: 'to_review' });
    await q(db, `select public.deposit_decide($1, 'confirm')`, [dep]);
    expect((await q(db, `select status, deposit_id from public.deposit_slips where id = $1`, [slip]))[0]).toEqual({ status: 'deposited', deposit_id: dep });
    // Taking a check off a slip updates its total.
    const [{ id: slip2 }] = await q<{ id: string }>(db, `select public.make_deposit_slip(array['ck-9']) id`).catch(() => [{ id: '' }]);
    expect(slip2).toBe('');
  });

  it('suggests certificate and card matches for an ACH deposit, posts nothing until confirmed, then funds the voucher batch', async () => {
    const [{ id: v }] = await q<{ id: string }>(db, `insert into public.vouchers (campaign_id, issuer, face_value, fee_type, issuer_number) values ('1003', 'Voucher — OJC Fund', 300, 'none', 'B-SAMPLE') returning id`);
    await q(db, `insert into public.voucher_lines (voucher_id, cert_number, amount) values ($1, 'C-0001', 100), ($1, 'C-0002', 200)`, [v]);
    await db.query(`insert into public.donations (org_id, id, campaign_id, type, status, amount, payment_method, card_last4, created_at, fee)
                    values ($1, 'card-1', '1001', 'Payment', 'completed', 36, 'OJC', '4242', '2026-11-18 15:00', 0)`, [OIZER]);
    const before = await count(db, `select count(*)::int n from public.donations`);
    const dep = await record(db, { kind: 'ojc_ach', issuer: 'OJC', issuer_ref: 'ACH-SAMPLE-1', deposit_date: '2026-11-19', gross: 336, fees: 1.08, net: 334.92, lines: [
      { kind: 'certificate', ref: 'C-0001', amount: 100, line_date: '2026-11-18' },
      { kind: 'certificate', ref: 'C-0002', amount: 200, line_date: '2026-11-18' },
      { kind: 'card', ref: 'T-0001', amount: 36, fee: 1.08, line_date: '2026-11-18', card_last4: '4242', donor_name: 'Sample Donor' },
    ] });
    const ls = await lines(db, dep);
    expect(ls.map(l => [l.kind, !!l.suggested_voucher_line, l.suggested_donation, l.outcome])).toEqual([
      ['certificate', true, null, 'open'], ['certificate', true, null, 'open'], ['card', false, 'card-1', 'open']]);
    expect(await count(db, `select count(*)::int n from public.donations`)).toBe(before);           // nothing posted yet
    expect((await db.query(`select 1 from public.task_items where task_key = $1 and resolved_at is null`, [`deposit_review:${dep}`])).rows.length).toBe(1);
    await expect(q(db, `select public.deposit_decide($1, 'confirm')`, [dep])).rejects.toThrow(/still need a decision/);
    for (const l of ls) await q(db, `select public.deposit_line_decide($1, 'match')`, [l.id]);
    // The card line's fee differs from the recorded one: a fee review, not a change.
    expect((await q(db, `select fee from public.donations where id = 'card-1'`))[0].fee).toBe('0.00');
    const [fr] = await q(db, `select id, recorded_fee, reported_fee, status from public.fee_reviews where donation_id = 'card-1'`);
    expect(fr).toMatchObject({ recorded_fee: '0.00', reported_fee: '1.08', status: 'open' });
    await q(db, `select public.deposit_decide($1, 'confirm')`, [dep]);
    expect((await q(db, `select status from public.voucher_lines where voucher_id = $1 order by cert_number`, [v])).map(r => r.status)).toEqual(['funded', 'funded']);
    expect((await q(db, `select count(*)::int n, sum(amount)::text total from public.donations where voucher_id = $1`, [v]))[0]).toEqual({ n: 1, total: '300.00' });
    // Applying the fee review makes it the gift's (manual) fee, kept from then on.
    await q(db, `select public.fee_review_decide($1, 'apply')`, [fr.id]);
    expect((await q(db, `select fee, manual_fee from public.donations where id = 'card-1'`))[0]).toEqual({ fee: '1.08', manual_fee: '1.08' });
  });

  it('creates a missing gift from a line, with the donor from the report, the issuer as method, and a fee review if the fee differs', async () => {
    await db.query(`insert into public.donors (org_id, id, first_name, last_name, ojc_id) values ($1, 'dsample', 'Sample', 'Person', 'OJC-ACCT-1')`, [OIZER]);
    const dep = await record(db, { kind: 'ojc_ach', issuer: 'OJC', issuer_ref: 'ACH-SAMPLE-2', deposit_date: '2026-11-19', net: 70, lines: [
      { kind: 'web', ref: 'T-0100', amount: 50, fee: 9.99, line_date: '2026-11-18', donor_account: 'OJC-ACCT-1', donor_name: 'Sample Person' },
      { kind: 'web', ref: 'T-0101', amount: 20, line_date: '2026-11-18', donor_name: 'Brand New Sample' },
    ] });
    const ls = await lines(db, dep);
    await expect(q(db, `select public.deposit_line_decide($1, 'create')`, [ls[0].id])).rejects.toThrow(/campaign/);
    const [{ id: g1 }] = await q<{ id: string }>(db, `select public.deposit_line_decide($1, 'create', null, '1001') id`, [ls[0].id]);
    const [{ id: g2 }] = await q<{ id: string }>(db, `select public.deposit_line_decide($1, 'create', null, '1001') id`, [ls[1].id]);
    const [a] = await q(db, `select donor_id, payment_method, amount, bank_reference from public.donations where id = $1`, [g1]);
    expect(a).toEqual({ donor_id: 'dsample', payment_method: 'OJC', amount: '50.00', bank_reference: 'ACH-SAMPLE-2' });
    const [b] = await q(db, `select d.donor_id is not null has_donor, dn.display_name from public.donations d left join public.donors dn on dn.org_id = d.org_id and dn.id = d.donor_id where d.id = $1`, [g2]);
    expect(b.has_donor).toBe(true);
    expect(b.display_name).toMatch(/Brand New Sample/);
    expect((await q(db, `select count(*)::int n from public.fee_reviews where donation_id = $1 and status = 'open'`, [g1]))[0].n).toBe(1);
  });

  it('flags a second copy of the same deposit, and a submission records certificates under its voucher batch', async () => {
    const p = { kind: 'pledger_ach', issuer: 'Pledger', issuer_ref: 'P-ACH-SAMPLE', deposit_date: '2026-11-19', net: 10, lines: [] };
    const first = await record(db, p);
    const second = await record(db, p);
    expect((await q(db, `select status, duplicate_of from public.deposits where id = $1`, [second]))[0]).toEqual({ status: 'possible_duplicate', duplicate_of: first });
    await q(db, `select public.deposit_decide($1, 'not_duplicate')`, [second]);
    expect((await q(db, `select status from public.deposits where id = $1`, [second]))[0].status).toBe('to_review');

    const [{ id: v }] = await q<{ id: string }>(db, `insert into public.vouchers (campaign_id, issuer, face_value, fee_type, issuer_number) values ('1003', 'Voucher — Pledger', 500, 'none', 'PB-SAMPLE') returning id`);
    const sub = await record(db, { kind: 'pledger_batch', issuer: 'Pledger', issuer_ref: 'PB-SAMPLE', deposit_date: '2026-11-19', gross: 300, lines: [
      { kind: 'certificate', ref: 'PC-1', amount: 100, cert_status: 'ready' }, { kind: 'certificate', ref: 'PC-2', amount: 200, cert_status: 'pending' }] });
    expect((await q(db, `select suggested_voucher from public.deposits where id = $1`, [sub]))[0].suggested_voucher).toBe(v);
    await q(db, `select public.deposit_set_voucher($1, $2)`, [sub, v]);
    await q(db, `select public.deposit_decide($1, 'confirm')`, [sub]);
    expect(await q(db, `select cert_number, amount, status from public.voucher_lines where voucher_id = $1 order by cert_number`, [v]))
      .toEqual([{ cert_number: 'PC-1', amount: '100.00', status: 'submitted' }, { cert_number: 'PC-2', amount: '200.00', status: 'pending' }]);
  });

  it('records an AB Charity payout total-only and suggests the bank deposit with that amount and date (Moshe, 2026-11-20)', async () => {
    expect((await q(db, `select category, receipt_allowed from public.payment_methods where name = 'AB Charity'`))[0]).toEqual({ category: 'DAF', receipt_allowed: false });
    await db.query(`insert into public.bank_lines (org_id, id, account_id, posted_date, amount, description, source, fingerprint) values
      ($1, 'bl-ab', 'a1', '2026-11-21', 1250, 'AB CHARITY PAYOUT (sample)', 'manual', 'fp-ab-1'),
      ($1, 'bl-other', 'a1', '2026-11-21', 999, 'Something else', 'manual', 'fp-ab-2')`, [OIZER]);
    const dep = await record(db, { kind: 'ab_charity', issuer: 'AB Charity', deposit_date: '2026-11-19', gross: 1250, net: 1250, lines: [] });
    expect((await q(db, `select suggested_bank_line, status from public.deposits where id = $1`, [dep]))[0]).toEqual({ suggested_bank_line: 'bl-ab', status: 'to_review' });
    expect((await db.query<{ s: string }>(`select summary s from public.task_items where task_key = $1`, [`deposit_review:${dep}`])).rows[0].s).toMatch(/AB Charity payout/);
    await q(db, `select public.deposit_decide($1, 'confirm')`, [dep]);
    expect((await q(db, `select status from public.deposits where id = $1`, [dep]))[0].status).toBe('confirmed');
  });

  it('keeps decisions to admins, fee decisions to those who can change fees, and the reader function to the server', async () => {
    const dep = await record(db, { kind: 'ojc_ach', issuer: 'OJC', issuer_ref: 'X', net: 1, lines: [{ kind: 'card', amount: 1 }] });
    const [l] = await lines(db, dep);
    await expect(q(db, `select public.deposit_line_decide($1, 'skip')`, [l.id], MANAGER_1)).rejects.toThrow();
    await expect(q(db, `select public.deposit_decide($1, 'dismiss')`, [dep], MANAGER_1)).rejects.toThrow();
    await expect(q(db, `select public.inbox_record_deposit($1, null, '{}'::jsonb)`, [OIZER])).rejects.toThrow();
    expect(await q(db, `select id from public.deposits`, [], MANAGER_1)).toEqual([]);
    await db.query(`update public.org_members set role = 'admin' where user_id = $1`, [ADMIN]);
    await db.query(`insert into public.donations (org_id, id, campaign_id, type, status, amount, payment_method, fee) values ($1, 'fx', '1001', 'Payment', 'completed', 10, 'Cash', 0)`, [OIZER]);
    await db.query(`insert into public.fee_reviews (org_id, donation_id, recorded_fee, reported_fee) values ($1, 'fx', 0, 1)`, [OIZER]);
    const [{ id }] = (await db.query<{ id: string }>(`select id from public.fee_reviews where donation_id = 'fx'`)).rows;
    await expect(q(db, `select public.fee_review_decide($1, 'apply')`, [id])).rejects.toThrow(/change fees/);
  });
});
