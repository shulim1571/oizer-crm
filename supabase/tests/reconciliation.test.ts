import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, MANAGER_1, OIZER, as, rows, seededDb } from './harness';

const ADMIN_2 = '00000000-0000-0000-0000-00000000000b';
const sql = (db: PGlite, q: string, params: unknown[] = [], user = ADMIN) => as(db, user, tx => tx.query(q, params));
const one = async <T = Record<string, any>>(db: PGlite, q: string, params: unknown[] = [], user = ADMIN) => (await rows<T>(db, user, q, params))[0];

type Line = { date: string; amount: number; description?: string; check_number?: string; bank_ref?: string };
const importLines = (db: PGlite, lines: Line[], account = 'a1', user = ADMIN) =>
  one<{ import_id: string; added: number; skipped_duplicate: number; skipped_locked: number }>(
    db, `select * from public.import_bank_lines($1, 'statement.csv', $2)`, [account, JSON.stringify(lines)], user);
const lineId = async (db: PGlite, amount: number, date?: string) =>
  (await one<{ id: string }>(db, `select id from public.bank_lines where amount = $1 ${date ? 'and posted_date = $2' : ''} order by created_at limit 1`,
    date ? [amount, date] : [amount])).id;
const gift = async (db: PGlite, amount: number, extra: Record<string, unknown> = {}) => {
  const v = { campaign_id: '1001', amount, payment_method: 'Check', account_id: 'a1', ...extra };
  const keys = Object.keys(v);
  return (await one<{ id: string }>(db, `insert into public.donations (${keys.join(',')}) values (${keys.map((_, i) => `$${i + 1}`).join(',')}) returning id`, Object.values(v))).id;
};
const giftOn = async (db: PGlite, amount: number, date: string, extra: Record<string, unknown> = {}) => {
  const id = await gift(db, amount, extra);
  await db.query(`update public.donations set created_at = ($2::date + time '12:00') at time zone 'America/New_York' where id = $1`, [id, date]);
  return id;
};
const payout = async (db: PGlite, amount: number, method = 'Zelle', date?: string) => {
  const id = (await one<{ id: string }>(db, `insert into public.expenses (campaign_id, amount, payee, method, account_id) values ('1001', $1, 'Acme', $2, 'a1') returning id`, [amount, method])).id;
  if (date) await db.query(`update public.expenses set processed_at = ($2::date + time '12:00') at time zone 'America/New_York' where id = $1`, [id, date]);
  return id;
};
const book = (db: PGlite, account = 'a1') => rows<Record<string, any>>(db, ADMIN, `select item_type, item_id, item_date::text as item_date, amount, fee, payment_method, description, check_number, campaign_id, match_id, excluded, exclude_reason from public.bank_book_items($1) order by 3, 1, 2`, [account]);
const unmatched = async (db: PGlite) => Number((await rows<{ n: string }>(db, ADMIN, `select count(*) n from public.bank_lines where match_id is null`))[0].n);
const autoMatch = async (db: PGlite) => (await one<{ n: number }>(db, `select public.auto_match_bank('a1') n`)).n;
const today = async (db: PGlite) => (await one<{ d: string }>(db, `select public.org_today()::text d`)).d;

async function secondAccount(db: PGlite) {
  await sql(db, `insert into public.accounts (id, name) values ('a2', 'Savings')`);
}

describe('bringing in bank lines', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); });

  it('adds each line once, even when the same statement comes in twice', async () => {
    const lines = [
      { date: '2026-10-01', amount: 18, description: 'Deposit' },
      { date: '2026-10-01', amount: 18, description: 'Deposit' },
      { date: '2026-10-02', amount: -250, description: 'Check 1001', check_number: '001001' },
    ];
    expect(await importLines(db, lines)).toMatchObject({ added: 3, skipped_duplicate: 0, skipped_locked: 0 });
    // An overlapping statement: the three lines already in, plus one new one.
    expect(await importLines(db, [...lines, { date: '2026-10-03', amount: 5.5, description: 'Interest' }]))
      .toMatchObject({ added: 1, skipped_duplicate: 3 });
    expect(await rows(db, ADMIN, `select posted_date::text, amount, check_number from public.bank_lines order by posted_date, amount`)).toEqual([
      { posted_date: '2026-10-01', amount: '18.00', check_number: null },
      { posted_date: '2026-10-01', amount: '18.00', check_number: null },
      { posted_date: '2026-10-02', amount: '-250.00', check_number: '1001' },
      { posted_date: '2026-10-03', amount: '5.50', check_number: null },
    ]);
  });

  it('refuses lines it can\'t read', async () => {
    await expect(importLines(db, [{ date: 'first of October', amount: 5 }])).rejects.toThrow(/can't be read/);
    await expect(importLines(db, [{ date: '2026-10-01' } as Line])).rejects.toThrow(/date and an amount. Line 1/);
    await expect(importLines(db, [{ date: '2099-01-01', amount: 5 }])).rejects.toThrow(/future/);
    await expect(importLines(db, [])).rejects.toThrow(/no bank lines/);
  });

  it('can undo a whole file until a line in it is matched', async () => {
    const imp = await importLines(db, [{ date: '2026-10-01', amount: 100 }, { date: '2026-10-02', amount: 7 }]);
    await sql(db, `select public.match_bank('a1', array[$1], '[]', 'interest')`, [await lineId(db, 7)]);
    await expect(sql(db, `select public.undo_bank_import($1)`, [imp.import_id])).rejects.toThrow(/matched/);
    await sql(db, `select public.unmatch_bank(match_id) from public.bank_lines where amount = 7`);
    expect((await one(db, `select public.undo_bank_import($1) n`, [imp.import_id])).n).toBe(2);
    expect(await unmatched(db)).toBe(0);
    await expect(sql(db, `select public.undo_bank_import($1)`, [imp.import_id])).rejects.toThrow(/already undone/);
  });

  it('takes a line typed in by hand, and deletes an unmatched one', async () => {
    const id = (await one(db, `select public.add_bank_line('a1', '2026-10-05', -12.5, 'Service charge') id`)).id;
    expect(await one(db, `select source, amount from public.bank_lines where id = $1`, [id])).toEqual({ source: 'manual', amount: '-12.50' });
    await sql(db, `select public.delete_bank_line($1)`, [id]);
    expect(await unmatched(db)).toBe(0);
  });

  it('is admin only, and stays inside the organization', async () => {
    await importLines(db, [{ date: '2026-10-01', amount: 100 }]);
    await expect(importLines(db, [{ date: '2026-10-01', amount: 1 }], 'a1', MANAGER_1)).rejects.toThrow(/Only admins/);
    expect(await rows(db, MANAGER_1, `select * from public.bank_lines`)).toEqual([]);
    await expect(sql(db, `insert into public.bank_lines (account_id, posted_date, amount, fingerprint) values ('a1', '2026-10-01', 1, 'x')`)).rejects.toThrow();
    await expect(sql(db, `update public.bank_lines set amount = 1`)).rejects.toThrow();
    await expect(rows(db, MANAGER_1, `select * from public.bank_book_items('a1')`)).rejects.toThrow(/Only admins/);

    const OTHER = '00000000-0000-4000-8000-0000000000ee';
    await db.query(`insert into public.organizations (id, slug, name) values ('${OTHER}', 'other', 'Other Org')`);
    await db.query(`insert into public.org_members (org_id, user_id, role) values ('${OTHER}', '${MANAGER_1}', 'admin')`);
    expect(await as(db, MANAGER_1, async tx => (await tx.query(`select * from public.bank_lines`)).rows, OTHER)).toEqual([]);
    await expect(as(db, MANAGER_1, tx => tx.query(`select public.import_bank_lines('a1', null, '[{"date":"2026-10-01","amount":1}]')`), OTHER))
      .rejects.toThrow(/Bank account not found/);
  });
});

describe('what the books expect', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); });

  it('lists gifts, reversals, payouts and printed checks on the account', async () => {
    const g = await giftOn(db, 100, '2026-10-01');
    const r = await giftOn(db, 40, '2026-10-02');
    await sql(db, `select public.return_check($1, '2026-10-09', 'NSF')`, [r]);
    await giftOn(db, 999, '2026-10-01', { account_id: null, payment_method: 'Cash' });
    const p = await payout(db, 60, 'Zelle', '2026-10-03');
    expect((await book(db)).map(b => [b.item_type, b.item_id, b.item_date, b.amount]).filter(x => [g, r, p].includes(x[1]))).toEqual([
      ['donation', g, '2026-10-01', '100.00'],
      ['donation', r, '2026-10-02', '40.00'],
      ['payout', p, '2026-10-03', '-60.00'],
      ['donation_reversal', r, '2026-10-09', '-40.00'],
    ]);
  });

  it('dates a post-dated check by its check date, and drops a payout whose only check was voided', async () => {
    // Not deposited until its date comes; then it's dated by the check.
    const later = await gift(db, 300, { post_dated: true, check_date: '2099-12-01' });
    expect((await book(db)).find(b => b.item_id === later)).toBeUndefined();
    const g = await gift(db, 300, { post_dated: true, check_date: '2026-10-15' });
    expect((await book(db)).find(b => b.item_id === g)?.item_date).toBe('2026-10-15');
    await sql(db, `select public.save_check_settings('a1', 'Cong Oizer', null, 'Chase', '021000021', '123456789', 5001)`);
    const e = await payout(db, 75, 'Check');
    const k = await one<{ check_id: string }>(db, `select * from public.issue_check($1, 'a1')`, [e]);
    expect((await book(db)).find(b => b.item_id === e)).toMatchObject({ check_number: '5001', amount: '-75.00' });
    await sql(db, `select public.set_check_status($1, 'voided', 'Misprinted')`, [k.check_id]);
    expect((await book(db)).find(b => b.item_id === e)).toBeUndefined();
  });

  it('sets aside an item that never went through the bank, with a reason', async () => {
    const g = await giftOn(db, 5000, '2026-01-01');
    await expect(sql(db, `select public.exclude_book_item('donation', $1, '')`, [g])).rejects.toThrow(/reason/);
    await sql(db, `select public.exclude_book_item('donation', $1, 'Opening balance from AppSheet')`, [g]);
    expect((await book(db)).find(b => b.item_id === g)).toMatchObject({ excluded: true, exclude_reason: 'Opening balance from AppSheet' });
    await sql(db, `select public.include_book_item('donation', $1)`, [g]);
    expect((await book(db)).find(b => b.item_id === g)?.excluded).toBe(false);
    await expect(sql(db, `select public.exclude_book_item('donation', 'nope', 'x')`)).rejects.toThrow(/not found/);
  });
});

describe('matching', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); });

  it('needs a reason for any difference, and a note for "other"', async () => {
    const a = await giftOn(db, 100, '2026-10-01');
    const b = await giftOn(db, 50, '2026-10-01');
    await importLines(db, [{ date: '2026-10-02', amount: 145.5 }]);
    const line = await lineId(db, 145.5);
    const items = JSON.stringify([{ type: 'donation', id: a }, { type: 'donation', id: b }]);
    await expect(sql(db, `select public.match_bank('a1', array[$1], $2)`, [line, items])).rejects.toThrow(/differ by -4.50/);
    await expect(sql(db, `select public.match_bank('a1', array[$1], $2, 'other')`, [line, items])).rejects.toThrow(/note/);
    const id = (await one(db, `select public.match_bank('a1', array[$1], $2, 'processor_fees') id`, [line, items])).id;
    expect(await one(db, `select kind, lines_total, items_total, difference, difference_type from public.recon_matches where id = $1`, [id]))
      .toEqual({ kind: 'manual', lines_total: '145.50', items_total: '150.00', difference: '-4.50', difference_type: 'processor_fees' });
    expect((await book(db)).filter(x => x.match_id === id).length).toBe(2);
  });

  it('won\'t use a line or item twice, or one from another account', async () => {
    await secondAccount(db);
    const a = await giftOn(db, 100, '2026-10-01');
    await importLines(db, [{ date: '2026-10-02', amount: 100 }, { date: '2026-10-03', amount: 100 }]);
    await importLines(db, [{ date: '2026-10-02', amount: 100, description: 'savings' }], 'a2');
    const [l1, l2] = (await rows<{ id: string }>(db, ADMIN, `select id from public.bank_lines where account_id = 'a1' order by posted_date`)).map(r => r.id);
    const other = (await one<{ id: string }>(db, `select id from public.bank_lines where account_id = 'a2'`)).id;
    const item = JSON.stringify([{ type: 'donation', id: a }]);
    await expect(sql(db, `select public.match_bank('a1', array[$1], $2)`, [other, item])).rejects.toThrow(/another account/);
    await sql(db, `select public.match_bank('a1', array[$1], $2)`, [l1, item]);
    await expect(sql(db, `select public.match_bank('a1', array[$1], $2)`, [l1, '[]'])).rejects.toThrow(/already matched/);
    await expect(sql(db, `select public.match_bank('a1', array[$1], $2)`, [l2, item])).rejects.toThrow(/already matched/);
    await expect(sql(db, `select public.match_bank('a2', array[$1], $2)`, [other, item])).rejects.toThrow(/not on this account/);
  });

  it('explains a bank-only line, like a fee or interest', async () => {
    await importLines(db, [{ date: '2026-10-31', amount: -15, description: 'Monthly service fee' }]);
    await expect(sql(db, `select public.match_bank('a1', array[$1])`, [await lineId(db, -15)])).rejects.toThrow(/Say what the difference is/);
    await sql(db, `select public.match_bank('a1', array[$1], '[]', 'bank_fee')`, [await lineId(db, -15)]);
    expect(await unmatched(db)).toBe(0);
  });

  it('clears a payout\'s check when matched, and puts it back when unmatched', async () => {
    await sql(db, `select public.save_check_settings('a1', 'Cong Oizer', null, 'Chase', '021000021', '123456789', 1001)`);
    const e = await payout(db, 250, 'Check');
    await sql(db, `select * from public.issue_check($1, 'a1')`, [e]);
    await importLines(db, [{ date: await today(db), amount: -250, check_number: '1001' }]);
    const id = (await one(db, `select public.match_bank('a1', array[$1], $2) id`, [await lineId(db, -250), JSON.stringify([{ type: 'payout', id: e }])])).id;
    expect(await one(db, `select k.status, e.cleared from public.checks k join public.expenses e on e.id = k.expense_id where k.expense_id = $1`, [e]))
      .toEqual({ status: 'cleared', cleared: true });
    await sql(db, `select public.unmatch_bank($1)`, [id]);
    expect(await one(db, `select k.status, e.cleared from public.checks k join public.expenses e on e.id = k.expense_id where k.expense_id = $1`, [e]))
      .toEqual({ status: 'outstanding', cleared: false });
    expect(await unmatched(db)).toBe(1);
  });

  it('logs each match and unmatch', async () => {
    await importLines(db, [{ date: '2026-10-31', amount: 2.1 }]);
    const id = (await one(db, `select public.match_bank('a1', array[$1], '[]', 'interest') id`, [await lineId(db, 2.1)])).id;
    await sql(db, `select public.unmatch_bank($1)`, [id]);
    const actions = (await rows<{ action: string }>(db, ADMIN, `select action from public.activity_log where action like 'bank_%' order by id`)).map(r => r.action);
    expect(actions).toEqual(['bank_lines_imported', 'bank_matched', 'bank_unmatched']);
  });
});

describe('automatic matching', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); });

  it('matches a check by its number and clears it', async () => {
    await sql(db, `select public.save_check_settings('a1', 'Cong Oizer', null, 'Chase', '021000021', '123456789', 1001)`);
    const e1 = await payout(db, 250, 'Check');
    const e2 = await payout(db, 250, 'Check');
    await sql(db, `select * from public.issue_check($1, 'a1')`, [e1]);
    await sql(db, `select * from public.issue_check($1, 'a1')`, [e2]);
    // Same amount twice: only the check number tells them apart.
    await importLines(db, [{ date: await today(db), amount: -250, check_number: '1002' }]);
    expect(await autoMatch(db)).toBe(1);
    expect((await rows(db, ADMIN, `select expense_id, status from public.checks order by check_number`)))
      .toEqual([{ expense_id: e1, status: 'outstanding' }, { expense_id: e2, status: 'cleared' }]);
  });

  it('pairs one line with one item when nothing else fits, and leaves look-alikes for a person', async () => {
    const a = await giftOn(db, 180, '2026-10-01');
    await giftOn(db, 36, '2026-10-01');
    await giftOn(db, 36, '2026-10-02');
    const p = await payout(db, 500, 'Zelle', '2026-10-05');
    await importLines(db, [
      { date: '2026-10-02', amount: 180 },
      { date: '2026-10-03', amount: 36 },
      { date: '2026-10-06', amount: -500 },
      { date: '2026-10-20', amount: 999 },
    ]);
    expect(await autoMatch(db)).toBe(2);
    const matched = (await book(db)).filter(b => b.match_id).map(b => b.item_id).sort();
    expect(matched).toEqual([a, p].sort());
    expect(await unmatched(db)).toBe(2);
    expect((await one(db, `select kind from public.recon_matches limit 1`)).kind).toBe('auto');
  });

  it('doesn\'t pair a deposit with a gift recorded long after it', async () => {
    await giftOn(db, 180, '2026-10-20');
    await importLines(db, [{ date: '2026-10-02', amount: 180 }]);
    expect(await autoMatch(db)).toBe(0);
  });

  it('matches a deposit to a day\'s checks', async () => {
    const ids = [await giftOn(db, 100, '2026-10-01'), await giftOn(db, 50, '2026-10-01'), await giftOn(db, 18, '2026-10-01')];
    await giftOn(db, 1000, '2026-10-01', { payment_method: 'Wire' });
    await importLines(db, [{ date: '2026-10-02', amount: 168, description: 'Deposit' }]);
    expect(await autoMatch(db)).toBe(1);
    expect((await book(db)).filter(b => b.match_id).map(b => b.item_id).sort()).toEqual(ids.sort());
  });

  it('matches a card settlement that arrives less its fees', async () => {
    const ids = [await giftOn(db, 100, '2026-10-01', { payment_method: 'Credit Card', fee: 3.2 }),
                 await giftOn(db, 250, '2026-10-01', { payment_method: 'Credit Card', fee: 7.55 })];
    await importLines(db, [{ date: '2026-10-03', amount: 339.25, description: 'SOLA SETTLEMENT' }]);
    expect(await autoMatch(db)).toBe(1);
    expect(await one(db, `select difference, difference_type from public.recon_matches`)).toEqual({ difference: '-10.75', difference_type: 'processor_fees' });
    expect((await book(db)).filter(b => b.match_id).map(b => b.item_id).sort()).toEqual(ids.sort());
  });

  it('skips set-aside items', async () => {
    const g = await giftOn(db, 180, '2026-10-01');
    await sql(db, `select public.exclude_book_item('donation', $1, 'Not ours')`, [g]);
    await importLines(db, [{ date: '2026-10-02', amount: 180 }]);
    expect(await autoMatch(db)).toBe(0);
  });
});

describe('transfers between bank accounts', () => {
  let db: PGlite;
  beforeEach(async () => {
    db = await seededDb();
    await secondAccount(db);
    await sql(db, `update public.campaigns set account_id = 'a2' where id = '1002'`);
    await sql(db, `update public.campaigns set account_id = 'a1' where id = '1001'`);
  });

  it('show on both accounts, and a cross-account campaign transfer asks for one', async () => {
    const t = (await one<{ id: string }>(db, `insert into public.transfers (amount, from_campaign_id, to_campaign_id, cross_account) values (75, '1001', '1002', true) returning id`)).id;
    expect(await one(db, `select task_type, amount, summary from public.admin_task_sheet where record_id = $1`, [t]))
      .toEqual({ task_type: 'bank_move_needed', amount: '75.00', summary: 'Move $75.00 from Operating to Savings for campaign 1001 → 1002' });
    expect(await rows(db, ADMIN, `select transfer_id, from_account, to_account from public.bank_moves_needed`))
      .toEqual([{ transfer_id: t, from_account: 'a1', to_account: 'a2' }]);

    await expect(sql(db, `select public.record_bank_transfer('a1', 'a2', 70, '2026-10-05', null, $1)`, [t])).rejects.toThrow(/was for 75.00/);
    const b = (await one(db, `select public.record_bank_transfer('a1', 'a2', 75, '2026-10-05', 'Move for 1002', $1) id`, [t])).id;
    expect(await rows(db, ADMIN, `select 1 from public.admin_task_sheet where record_id = $1`, [t])).toEqual([]);
    expect(await rows(db, ADMIN, `select * from public.bank_moves_needed`)).toEqual([]);
    expect((await book(db, 'a1')).find(x => x.item_id === b)).toMatchObject({ item_type: 'bank_transfer_out', amount: '-75.00', description: 'Transfer to Savings · Move for 1002' });
    expect((await book(db, 'a2')).find(x => x.item_id === b)).toMatchObject({ item_type: 'bank_transfer_in', amount: '75.00' });
    await expect(sql(db, `select public.record_bank_transfer('a1', 'a2', 75, '2026-10-05', null, $1)`, [t])).rejects.toThrow(/already has/);

    // Deleting it puts the request back.
    await sql(db, `select public.delete_bank_transfer($1, 'Wrong date')`, [b]);
    expect((await rows(db, ADMIN, `select 1 from public.admin_task_sheet where record_id = $1`, [t])).length).toBe(1);
  });

  it('can\'t be deleted once matched, and need two different accounts', async () => {
    await expect(sql(db, `select public.record_bank_transfer('a1', 'a1', 5, '2026-10-05')`)).rejects.toThrow(/two different/);
    const b = (await one(db, `select public.record_bank_transfer('a1', 'a2', 500, '2026-10-05') id`)).id;
    await importLines(db, [{ date: '2026-10-05', amount: -500 }]);
    expect(await autoMatch(db)).toBe(1);
    await expect(sql(db, `select public.delete_bank_transfer($1, 'x')`, [b])).rejects.toThrow(/Unmatch it first/);
  });

  it('aren\'t asked for when the campaigns share an account', async () => {
    await sql(db, `update public.campaigns set account_id = 'a1' where id = '1003'`);
    await sql(db, `insert into public.transfers (amount, from_campaign_id, to_campaign_id) values (10, '1001', '1003')`);
    expect(await rows(db, ADMIN, `select * from public.bank_moves_needed`)).toEqual([]);
  });
});

describe('signing off a period', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); });
  const signOff = (end: string, balance: number, opening: number | null = 1000, start: string | null = '2026-09-01', user = ADMIN) =>
    one<{ id: string }>(db, `select public.sign_off_bank_period('a1', $1, $2, $3, $4) id`, [end, balance, opening, start], user);

  async function september() {
    const g = await giftOn(db, 200, '2026-09-10');
    await giftOn(db, 300, '2026-09-29');         // deposited in October: in transit at the end of September
    await payout(db, 80, 'Zelle', '2026-09-30'); // left the bank in October
    await importLines(db, [
      { date: '2026-09-11', amount: 200 },
      { date: '2026-09-30', amount: -12, description: 'Service fee' },
      { date: '2026-10-01', amount: 300 },
    ]);
    await sql(db, `select public.match_bank('a1', array[$1], $2)`, [await lineId(db, 200), JSON.stringify([{ type: 'donation', id: g }])]);
    return g;
  }

  it('needs every line in the period explained, and the statement balance to add up', async () => {
    await september();
    await expect(signOff('2026-09-30', 1188, null, null)).rejects.toThrow(/first period/);
    await expect(signOff('2026-09-30', 1188)).rejects.toThrow(/1 bank line through September 30, 2026 still need/);
    await sql(db, `select public.match_bank('a1', array[$1], '[]', 'bank_fee')`, [await lineId(db, -12)]);
    await expect(signOff('2026-09-30', 1190)).rejects.toThrow(/bring 1,000.00 to 1,188.00, not the 1,190.00/);
    const id = (await signOff('2026-09-30', 1188)).id;
    const p = await one(db, `select period_start::text, opening_balance, statement_balance, lines_total, report from public.bank_periods where id = $1`, [id]);
    expect(p).toMatchObject({ period_start: '2026-09-01', opening_balance: '1000.00', statement_balance: '1188.00', lines_total: '188.00' });
    expect(p.report).toMatchObject({ deposits_in_transit: 300, outstanding_payments: -80, adjusted_balance: 1408, line_count: 2, deposits: 200, withdrawals: -12,
      differences: [{ type: 'bank_fee', total: -12, count: 1 }] });
    expect(p.report.outstanding.map((o: any) => [o.item_type, o.amount])).toEqual([['donation', 300], ['payout', -80]]);
  });

  it('locks everything up to its end', async () => {
    await september();
    await sql(db, `select public.match_bank('a1', array[$1], '[]', 'bank_fee')`, [await lineId(db, -12)]);
    await signOff('2026-09-30', 1188);
    const m = (await one(db, `select match_id from public.bank_lines where amount = 200`)).match_id;
    await expect(sql(db, `select public.unmatch_bank($1)`, [m])).rejects.toThrow(/signed-off period/);
    expect(await importLines(db, [{ date: '2026-09-15', amount: 1 }, { date: '2026-10-02', amount: 2 }])).toMatchObject({ added: 1, skipped_locked: 1 });
    await expect(sql(db, `select public.add_bank_line('a1', '2026-09-20', 5, 'late')`)).rejects.toThrow(/signed-off period/);
    await expect(signOff('2026-09-15', 1188)).rejects.toThrow(/Already signed off through 2026-09-30/);
  });

  it('carries the ending balance into the next period', async () => {
    await september();
    await sql(db, `select public.match_bank('a1', array[$1], '[]', 'bank_fee')`, [await lineId(db, -12)]);
    await signOff('2026-09-30', 1188);
    await sql(db, `select public.auto_match_bank('a1')`);
    expect(await unmatched(db)).toBe(0);
    await expect(signOff('2026-10-31', 1488, 999)).rejects.toThrow(/last period's ending balance, 1,188.00/);
    const id = (await signOff('2026-10-31', 1488, null, null)).id;
    const p = await one(db, `select period_start::text, opening_balance, report from public.bank_periods where id = $1`, [id]);
    expect(p).toMatchObject({ period_start: '2026-10-01', opening_balance: '1188.00' });
    // The payout dated September 30 is still waiting for the bank.
    expect(p.report.outstanding.map((o: any) => o.amount)).toEqual([-80]);
    expect(await one(db, `select locked_through::text, last_statement_balance, unmatched_lines from public.bank_reconciliation_summary() where account_id = 'a1'`))
      .toEqual({ locked_through: '2026-10-31', last_statement_balance: '1488.00', unmatched_lines: 0 });
  });

  it('reopens only the latest, by the Super Admin, with a reason', async () => {
    await db.exec(`insert into auth.users (id, email) values ('${ADMIN_2}', 'second@example.org');
                   insert into public.org_members (org_id, user_id, role) values ('${OIZER}', '${ADMIN_2}', 'admin');`);
    await september();
    await sql(db, `select public.match_bank('a1', array[$1], '[]', 'bank_fee')`, [await lineId(db, -12)]);
    const sep = (await signOff('2026-09-30', 1188)).id;
    await sql(db, `select public.auto_match_bank('a1')`);
    const oct = (await signOff('2026-10-31', 1488, null, null)).id;
    await expect(sql(db, `select public.reopen_bank_period($1, 'fix')`, [oct], ADMIN_2)).rejects.toThrow(/Only the Super Admin/);
    await expect(sql(db, `select public.reopen_bank_period($1, '')`, [oct])).rejects.toThrow(/reason/);
    await expect(sql(db, `select public.reopen_bank_period($1, 'fix')`, [sep])).rejects.toThrow(/later periods first/);
    await sql(db, `select public.reopen_bank_period($1, 'Missed a deposit')`, [oct]);
    expect((await one(db, `select locked_through::text from public.bank_reconciliation_summary() where account_id = 'a1'`)).locked_through).toBe('2026-09-30');
    // October's matches can change again; September's can't.
    const octMatch = (await one(db, `select match_id from public.bank_lines where amount = 300`)).match_id;
    await sql(db, `select public.unmatch_bank($1)`, [octMatch]);
  });

  it('is admin only, and can\'t end in the future', async () => {
    await expect(signOff('2026-09-30', 1000, 1000, '2026-09-01', MANAGER_1)).rejects.toThrow(/Only admins/);
    await expect(signOff('2099-01-31', 1000)).rejects.toThrow(/future/);
    expect(await rows(db, MANAGER_1, `select * from public.bank_periods`)).toEqual([]);
  });
});
