import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, MANAGER_1, OIZER, as, rows, seededDb } from './harness';

const sql = (db: PGlite, q: string, params: unknown[] = [], user = ADMIN) => as(db, user, tx => tx.query(q, params));
const one = async <T = Record<string, any>>(db: PGlite, q: string, params: unknown[] = [], user: string = ADMIN) => (await rows<T>(db, user, q, params))[0];
const run = (db: PGlite) => db.query(`select public.run_notifications()`);
const give = async (db: PGlite, campaign: string, amount: number, extra: Record<string, unknown> = {}) => {
  const cols = { campaign_id: campaign, donor_id: 'd1', amount, type: 'Payment', status: 'completed', payment_method: 'Check', ...extra };
  const keys = Object.keys(cols);
  return (await one<{ id: string }>(db, `insert into public.donations (${keys.join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
    Object.values(cols))).id;
};
type Msg = { to_address: string; subject: string; body: string; kind: string; channel: string };
const sent = async (db: PGlite, kind?: string) =>
  (await db.query<Msg>(`select to_address, subject, body, kind, channel from public.messages ${kind ? `where kind = '${kind}'` : ''} order by to_address, created_at`)).rows;
const prefs = (db: PGlite, p: Record<string, unknown>, user = ADMIN) =>
  sql(db, `select public.save_notification_preferences($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [p.phone ?? null, p.donation_alerts ?? 'off', p.donation_min ?? null, p.donation_campaigns ?? null, p.donation_digest ?? 'off',
     p.task_alerts ?? 'both', p.payout_alerts ?? 'immediate', p.weekly_digests ?? true, p.channels ?? {}], user);

describe('notifications', () => {
  let base: PGlite;
  let db: PGlite;
  beforeAll(async () => {
    base = await seededDb();
    await base.query(`insert into public.org_domains (hostname, org_id) values ('oizer.example.org', $1) on conflict do nothing`, [OIZER]);
    await base.query(`insert into public.messaging_settings (org_id, live) values ($1, true)`, [OIZER]);
    await base.query(`update public.notification_state set since = clock_timestamp()`);
  });
  beforeEach(async () => {
    db = await base.clone();
  });

  it('tell every fundraiser on the campaign about a donation, once', async () => {
    await give(db, '1003', 180);
    await run(db);
    await run(db);
    const m = await sent(db, 'donation');
    expect(m.map(x => x.to_address)).toEqual(['one@example.org', 'two@example.org']);
    expect(m[0].subject).toBe('New donation to Shared campaign (1003)');
    expect(m[0].body).toContain('$180.00 from Donor One');
    expect(m[0].body).toContain('Payment method: Check');
    expect(m[0].body).toContain('https://oizer.example.org/#/donors/d1');
  });

  it('leave out machine payments, opening balances and anything from before', async () => {
    await db.query(`insert into public.machines (org_id, id, nickname, donary_id, source_id) values ($1, 'mc1', 3, 'DP_3', 's1')`, [OIZER]);
    await give(db, '1001', 20, { source: 's1' });
    await give(db, '1001', 500, { payment_method: 'Opening Balance' });
    await db.query(`update public.notification_state set since = now() + interval '1 minute'`);
    await give(db, '1001', 40);
    await run(db);
    expect(await sent(db, 'donation')).toEqual([]);
  });

  it('send admins the donations they asked for, with fee, net and balance', async () => {
    await prefs(db, { donation_alerts: 'over', donation_min: 100 });
    await give(db, '1001', 99);
    await give(db, '1001', 250, { fee: 7.5 });
    await run(db);
    const admin = (await sent(db, 'donation')).filter(x => x.to_address === 'office@example.org');
    expect(admin).toHaveLength(1);
    expect(admin[0].body).toContain('$250.00 from Donor One');
    expect(admin[0].body).toContain('Fee $7.50 · net $242.50 credited');
    expect(admin[0].body).toMatch(/Campaign balance now \$[\d,]+\.\d\d/);
  });

  it('tell only the refunded campaign\'s team about a refund', async () => {
    await db.query(`update public.notification_state set since = now() + interval '1 minute'`);
    const id = await give(db, '1001', 60);
    await db.query(`update public.notification_state set since = now() - interval '1 minute'`);
    await db.query(`update public.donations set status = 'refunded', reversal_reason = 'Donor asked', updated_at = now() where id = $1`, [id]);
    await run(db);
    const m = await sent(db, 'refund');
    expect(m.map(x => x.to_address)).toEqual(['one@example.org']);
    expect(m[0].body).toContain('was refunded');
    expect(m[0].body).toContain('Reason: Donor asked');
  });

  it('alert admins to new Task Sheet items after learning what was already there', async () => {
    await run(db);
    expect(await sent(db, 'task_alert')).toEqual([]);
    await give(db, null as never, 75, { status: 'completed', donor_id: null, name: 'Walk-in' });
    await run(db);
    const m = await sent(db, 'task_alert');
    expect(m).toHaveLength(1);
    expect(m[0].subject).toBe('New on the Task Sheet');
    expect(m[0].body).toContain('Unattributed payment: Check from Walk-in · $75.00');
    await run(db);
    expect(await sent(db, 'task_alert')).toHaveLength(1);
    await prefs(db, { task_alerts: 'off' });
    await give(db, null as never, 5, { donor_id: null, name: 'Second' });
    await run(db);
    expect(await sent(db, 'task_alert')).toHaveLength(1);
  });

  it('send the morning digest of items waiting a day, and fundraisers their tasks due today', async () => {
    await run(db);
    await db.query(`update public.task_sheet_seen set first_seen_at = now() - interval '2 days'`);
    await db.query(`insert into public.tasks (org_id, id, title, campaign_id, owner_manager_id, due_date, status)
                    values ($1, 'kt', 'Call the Kleins', '1001', 'm1', (now() at time zone 'America/New_York')::date, 'Pending')`, [OIZER]);
    await db.query(`update public.notification_state set last_morning = null`);
    await db.query(`select public.notify_morning($1)`, [OIZER]);
    const digest = await sent(db, 'task_digest');
    expect(digest.map(x => x.to_address)).toEqual(['office@example.org']);
    expect(digest[0].subject).toMatch(/Task Sheet items? still waiting/);
    const reminder = await sent(db, 'task_reminder');
    expect(reminder.map(x => x.to_address)).toEqual(['one@example.org']);
    expect(reminder[0].body).toContain('Call the Kleins · First campaign (1001)');
  });

  it('send the weekly open pledges digest to admins who keep it', async () => {
    await db.query(`select public.notify_weekly($1)`, [OIZER]);
    const m = await sent(db, 'pledge_digest');
    expect(m.map(x => x.to_address)).toEqual(['office@example.org']);
    expect(m[0].body).toContain('$500.00 open');
    await prefs(db, { weekly_digests: false });
    await db.query(`delete from public.messages`);
    await db.query(`select public.notify_weekly($1)`, [OIZER]);
    expect(await sent(db, 'pledge_digest')).toEqual([]);
  });

  it('sum up each machine\'s day for the campaign team, by text when they chose it', async () => {
    await db.query(`insert into public.machines (org_id, id, nickname, donary_id, source_id) values ($1, 'mc1', 3, 'DP_3', 's1')`, [OIZER]);
    await give(db, '1001', 20, { source: 's1' });
    await give(db, '1001', 30, { source: 's1' });
    await db.query(`update public.managers set phone = '718-555-0101' where id = 'm1'`);
    await prefs(db, { channels: { machine_digest: 'both' } }, MANAGER_1);
    await db.query(`select public.notify_machine_digest($1)`, [OIZER]);
    const m = await sent(db, 'machine_digest');
    expect(m.map(x => x.channel)).toEqual(['sms', 'email']);
    expect(m[1].subject).toBe('Today\'s machine activity — First campaign (1001)');
    expect(m[1].body).toContain('Machine 3: 2 transactions · $50.00');
    expect(m[1].body).toContain('Total: 2 transactions · $50.00');
  });

  it('email the fundraiser when their payout request or campaign request is decided', async () => {
    const pr = (await one<{ id: string }>(db, `select public.request_payout('1001', 50, false, 'Someone', 'Zelle', null, null, null, null, null, 'someone@example.com') as id`, [], MANAGER_1)).id;
    await sql(db, `select public.reject_payout_request($1, 'Balance is spoken for')`, [pr]);
    const p = await sent(db, 'payout_request');
    expect(p.map(x => x.to_address)).toEqual(['one@example.org']);
    expect(p[0].subject).toBe('Your payout request was not approved');
    expect(p[0].body).toContain('Note from the office: Balance is spoken for');

    const cr = (await one<{ id: string }>(db, `select public.submit_campaign_request('Winter drive', 'About it', 5000, 'Please hurry', null) as id`, [], MANAGER_1)).id;
    await sql(db, `select public.decide_campaign_request($1, 'rejected', 'Not this year')`, [cr]);
    const c = await sent(db, 'campaign_request');
    expect(c[0]).toMatchObject({ to_address: 'one@example.org', subject: 'Your campaign request was not approved' });
  });

  it('confirm a machine request with its place in line', async () => {
    await one(db, `select public.request_machine('2099-03-10', '1001') as id`, [], MANAGER_1);
    const m = await sent(db, 'machine_booking');
    expect(m[0].to_address).toBe('one@example.org');
    expect(m[0].subject).toMatch(/^Machine request received for /);
    expect(m[0].body).toContain('You\'re number 1 in line');
  });

  it('tell people added to a campaign, and its primary', async () => {
    await sql(db, `update public.campaigns set sub_manager_ids = '{m2}' where id = '1001'`);
    const m = await sent(db, 'team_added');
    expect(m.map(x => [x.to_address, x.subject])).toEqual([
      ['one@example.org', 'Your campaign team changed'],
      ['two@example.org', 'You were added to First campaign (1001)'],
    ]);
  });

  it('keep preferences to their owner and check them', async () => {
    await expect(prefs(db, { donation_alerts: 'over' })).rejects.toThrow(/Enter the amount/);
    await expect(prefs(db, { channels: { donations: 'pigeon' } })).rejects.toThrow(/Choose email, text, both or off/);
    await prefs(db, { channels: { donations: 'off' } }, MANAGER_1);   // a kind can be turned off (Moshe Henig, 2026-11-12)
    await prefs(db, { donation_alerts: 'all' }, MANAGER_1);
    expect(await rows(db, MANAGER_1, `select donation_alerts from public.notification_preferences`)).toEqual([{ donation_alerts: 'off' }]);
    expect(await rows(db, ADMIN, `select * from public.notification_preferences`)).toEqual([]);
  });
});
