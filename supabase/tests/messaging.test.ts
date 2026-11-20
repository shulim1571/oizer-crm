import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, MANAGER_1, OIZER, as, rows, seededDb } from './harness';

const sql = (db: PGlite, q: string, params: unknown[] = [], user = ADMIN) => as(db, user, tx => tx.query(q, params));
const one = async <T = Record<string, any>>(db: PGlite, q: string, params: unknown[] = [], user: string = ADMIN) => (await rows<T>(db, user, q, params))[0];
const settings = (db: PGlite, live: boolean, tests: string[] = [], sms = '845-613-4272') =>
  sql(db, `select public.save_messaging_settings('Oizer', null, 'office@oizer.org', $1, $2, $3)`, [sms, live, tests]);
const msg = (db: PGlite, id: string) => one(db, `select * from public.messages where id = $1`, [id]);
const test = async (db: PGlite, channel: string, to: string) => (await one<{ id: string }>(db, `select public.send_test_message($1, $2) as id`, [channel, to])).id;
const svc = (db: PGlite, q: string, params: unknown[] = []) => rows(db, 'service_role', q, params);

describe('messaging', () => {
  let base: PGlite;
  let db: PGlite;
  beforeAll(async () => {
    base = await seededDb();
    await base.query(`select vault.create_secret('https://example.supabase.co', 'project_url')`);
  });
  beforeEach(async () => {
    db = await base.clone();
  });

  it('normalizes phone numbers and email addresses', async () => {
    const r = await one(db, `select public.normalize_phone('(845) 613-4272') a, public.normalize_phone('1-845-613-4272') b, public.normalize_phone('+972 52-123-4567') c,
                                    public.normalize_phone('613-4272') d, public.normalize_address('email', ' Office@Oizer.ORG ') e, public.normalize_address('email', 'not an email') f`);
    expect(r).toEqual({ a: '+18456134272', b: '+18456134272', c: '+972521234567', d: null, e: 'office@oizer.org', f: null });
  });

  it('holds messages to anyone off the test list until sending is switched on', async () => {
    await settings(db, false, ['me@example.org', '(718) 555-0100']);
    const held = await msg(db, await test(db, 'email', 'donor@example.org'));
    expect(held).toMatchObject({ status: 'held', to_address: 'donor@example.org' });
    const ok = await msg(db, await test(db, 'sms', '718.555.0100'));
    expect(ok).toMatchObject({ status: 'queued', to_address: '+17185550100', kind: 'test' });
    await settings(db, true);
    expect(await msg(db, await test(db, 'email', 'donor@example.org'))).toMatchObject({ status: 'queued' });
  });

  it('refuses bad addresses and keeps fundraisers out', async () => {
    await settings(db, true);
    await expect(test(db, 'email', 'nope')).rejects.toThrow(/isn't a valid email address/);
    await expect(test(db, 'sms', '123')).rejects.toThrow(/isn't a valid phone number/);
    await expect(test(db, 'sms', '')).rejects.toThrow(/No phone number/);
    await expect(sql(db, `select public.send_test_message('email', 'a@b.org')`, [], MANAGER_1)).rejects.toThrow();
    await expect(sql(db, `select public.save_messaging_settings(null, 'bad', null, null, true, '{}')`)).rejects.toThrow(/valid email/);
    expect(await rows(db, MANAGER_1, `select * from public.messages`)).toEqual([]);
  });

  it('wakes the sender with the secret token when something is ready to go', async () => {
    await settings(db, true);
    await test(db, 'email', 'a@example.org');
    const calls = (await db.query<{ url: string; headers: Record<string, string> }>(`select url, headers from net.requests`)).rows;
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://example.supabase.co/functions/v1/send-messages');
    const token = calls[0].headers['x-cron-token'];
    expect((await svc(db, `select public.check_cron_token($1) ok`, [token]))[0].ok).toBe(true);
    expect((await svc(db, `select public.check_cron_token('guess') ok`))[0].ok).toBe(false);
    await expect(rows(db, ADMIN, `select public.check_cron_token($1)`, [token])).rejects.toThrow();
  });

  it('hands queued messages to the sender once, with the organization\'s sender details', async () => {
    await settings(db, true);
    const id = await test(db, 'sms', '718-555-0100');
    await test(db, 'email', 'a@example.org');
    const claimed = await svc(db, `select * from public.claim_messages(10)`);
    expect(claimed).toHaveLength(2);
    expect(claimed.find(c => c.id === id)).toMatchObject({ channel: 'sms', from_name: 'Oizer', from_email: 'notifications@mail.trubase.org',
      reply_to: 'office@oizer.org', sms_from: '+18456134272', org_id: OIZER });
    expect(await svc(db, `select * from public.claim_messages(10)`)).toEqual([]);
    await svc(db, `select public.message_sent($1, $2, true, 'SM123', null)`, [OIZER, id]);
    expect(await msg(db, id)).toMatchObject({ status: 'sent', provider_id: 'SM123', attempts: 1 });
  });

  it('records delivery reports without moving backwards', async () => {
    await settings(db, true);
    const id = await test(db, 'email', 'a@example.org');
    await svc(db, `select * from public.claim_messages(10)`);
    await svc(db, `select public.message_sent($1, $2, true, 'abc123', null)`, [OIZER, id]);
    await svc(db, `select public.message_event(null, null, 'abc123.filter0001.123.0', 'delivered', null, now())`);
    await svc(db, `select public.message_event($1, $2, null, 'open', null, now())`, [OIZER, id]);
    await svc(db, `select public.message_event($1, $2, null, 'bounce', 'late bounce', now())`, [OIZER, id]);
    const m = await msg(db, id);
    expect(m.status).toBe('delivered');
    expect(m.opened_at).not.toBeNull();
  });

  it('turns a failure into one Delivery Failed task per message, cleared by resending', async () => {
    await settings(db, true);
    const a = await test(db, 'email', 'bad@example.org');
    const b = await test(db, 'email', 'worse@example.org');
    await svc(db, `select * from public.claim_messages(10)`);
    await svc(db, `select public.message_sent($1, $2, false, null, 'Mailbox does not exist')`, [OIZER, a]);
    await svc(db, `select public.message_sent($1, $2, true, 'x2', null)`, [OIZER, b]);
    await svc(db, `select public.message_event($1, $2, 'x2', 'bounce', '550 mailbox full', now())`, [OIZER, b]);
    const tasks = await rows(db, ADMIN, `select task_key, record_id, summary from public.admin_task_sheet where task_type = 'delivery_failed' order by summary`);
    expect(tasks).toHaveLength(2);
    expect(tasks[0].summary).toBe('Test by email to bad@example.org: Mailbox does not exist');
    const again = (await one<{ id: string }>(db, `select public.resend_message($1, 'good@example.org') id`, [a])).id;
    expect(await msg(db, again)).toMatchObject({ status: 'queued', to_address: 'good@example.org', subject: (await msg(db, a)).subject });
    expect(await rows(db, ADMIN, `select 1 from public.admin_task_sheet where task_type = 'delivery_failed'`)).toHaveLength(1);
    await expect(sql(db, `select public.resend_message($1)`, [again])).rejects.toThrow(/Only a failed or held/);
  });

  it('honors STOP and START replies to the organization\'s number', async () => {
    await settings(db, true);
    await svc(db, `select public.sms_inbound('+18456134272', '+17185550100', ' stop ')`);
    expect(await msg(db, await test(db, 'sms', '718-555-0100'))).toMatchObject({ status: 'opted_out' });
    await svc(db, `select public.sms_inbound('+18456134272', '+17185550100', 'START')`);
    expect(await msg(db, await test(db, 'sms', '718-555-0100'))).toMatchObject({ status: 'queued' });
    // A number the provider reports as unsubscribed is recorded too.
    const id = await test(db, 'sms', '718-555-0199');
    await svc(db, `select public.message_sent($1, $2, false, null, 'Unsubscribed recipient', true)`, [OIZER, id]);
    expect(await msg(db, id)).toMatchObject({ status: 'opted_out' });
    expect(await rows(db, ADMIN, `select address from public.message_opt_outs`)).toEqual([{ address: '+17185550199' }]);
  });

  it('sends a receipt by email with the page, and by text with a private link', async () => {
    await settings(db, true);
    const r = await one(db, `select public.send_document('receipt', 'r1', 'd1', 'R-2026-00001', '<p>Receipt</p>', 'donor@example.org', '7185550100', 'https://oizer.trubase.org/')`);
    const out = r.send_document;
    expect(await msg(db, out.email)).toMatchObject({ channel: 'email', html: '<p>Receipt</p>', to_name: 'Donor One', kind: 'receipt', record_id: 'r1' });
    const text = await msg(db, out.sms);
    const token = /#\/d\/([0-9a-f]+)$/.exec(text.body)![1];
    expect(text.body).toMatch(/^Oizer Umoshia: your receipt R-2026-00001 is here: https:\/\/oizer\.trubase\.org\/#\/d\//);
    expect(await rows(db, 'anon', `select * from public.shared_document($1)`, [token])).toEqual([{ title: 'R-2026-00001', html: '<p>Receipt</p>' }]);
    expect(await rows(db, 'anon', `select * from public.shared_document('0000')`)).toEqual([]);
    await expect(rows(db, 'anon', `select * from public.shared_documents`)).rejects.toThrow();
    expect(await rows(db, ADMIN, `select action from public.activity_log where action = 'send_receipt'`)).toHaveLength(1);
  });

  it('reports an unfinished send instead of trying again', async () => {
    await settings(db, true);
    const id = await test(db, 'email', 'a@example.org');
    await svc(db, `select * from public.claim_messages(10)`);
    await db.query(`update public.messages set created_at = now() - interval '1 hour' where id = $1`, [id]);
    await db.query(`select public.kick_sender_if_due()`);
    expect(await msg(db, id)).toMatchObject({ status: 'failed' });
  });
});
