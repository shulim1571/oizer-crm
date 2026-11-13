import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, MANAGER_1, MANAGER_2, OIZER, as, rows, seededDb } from './harness';

const sql = (db: PGlite, q: string, params: unknown[] = [], user = ADMIN) => as(db, user, tx => tx.query(q, params));
const one = async <T = Record<string, any>>(db: PGlite, q: string, params: unknown[] = [], user: string = ADMIN) => (await rows<T>(db, user, q, params))[0];
const threads = (db: PGlite, user: string) => rows(db, user, `select * from public.my_threads()`);
const post = async (db: PGlite, thread: string, body: string, user = ADMIN) => (await one(db, `select public.post_message($1, $2) id`, [thread, body], user)).id;
const chat = async (db: PGlite) => (await db.query<{ to_address: string; subject: string; body: string }>(`select to_address, subject, body from public.messages where kind = 'chat' order by created_at, to_address`)).rows;

describe('internal messaging', () => {
  let base: PGlite;
  let db: PGlite;
  beforeAll(async () => {
    base = await seededDb();
    await base.query(`insert into public.org_domains (hostname, org_id) values ('oizer.example.org', $1) on conflict do nothing`, [OIZER]);
    await base.query(`insert into public.messaging_settings (org_id, live) values ($1, true)`, [OIZER]);
  });
  beforeEach(async () => { db = await base.clone(); });

  it('give each fundraiser one conversation with the office, private to them', async () => {
    const [mine] = await threads(db, MANAGER_1);
    expect(mine).toMatchObject({ kind: 'direct', title: 'The office', manager_id: 'm1', unread: 0 });
    await post(db, mine.id, 'Can you check my last batch?', MANAGER_1);
    expect(await threads(db, MANAGER_2)).toEqual([expect.objectContaining({ manager_id: 'm2' })]);
    await expect(post(db, mine.id, 'Snooping', MANAGER_2)).rejects.toThrow(/can't write in this conversation/);
    const admin = await threads(db, ADMIN);
    expect(admin).toEqual([expect.objectContaining({ title: 'Manager One', unread: 1, last_preview: 'Can you check my last batch?', last_from: 'Manager One' })]);
  });

  it('show unread counts and read receipts both ways', async () => {
    const t = await one(db, `select public.open_direct_thread('m1') id`);
    await post(db, t.id, 'Your campaign is ready');
    expect((await threads(db, MANAGER_1))[0].unread).toBe(1);
    expect(await one(db, `select public.unread_message_count() n`, [], MANAGER_1)).toEqual({ n: 1 });
    expect((await rows(db, ADMIN, `select read_at from public.thread_history($1)`, [t.id]))[0].read_at).toBeNull();
    await sql(db, `select public.mark_thread_read($1)`, [t.id], MANAGER_1);
    expect((await threads(db, MANAGER_1))[0].unread).toBe(0);
    const [h] = await rows(db, ADMIN, `select from_office, mine, read_at from public.thread_history($1)`, [t.id]);
    expect(h.from_office).toBe(true);
    expect(h.mine).toBe(true);
    expect(h.read_at).not.toBeNull();
  });

  it('email the fundraiser when the office writes, once per burst', async () => {
    const t = await one(db, `select public.open_direct_thread('m1') id`);
    await post(db, t.id, 'Please **call** me');
    await post(db, t.id, 'Anytime today');
    const m = await chat(db);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ to_address: 'one@example.org', subject: 'New message from office@example.org' });
    expect(m[0].body).toContain('Please call me');
    expect(m[0].body).toContain(`https://oizer.example.org/#/inbox/${t.id}`);
    await sql(db, `select public.mark_thread_read($1)`, [t.id], MANAGER_1);
    await db.query(`update public.thread_reads set read_at = now() + interval '1 second'`);
    await post(db, t.id, 'One more');
    expect(await chat(db)).toHaveLength(2);
  });

  it('email admins about fundraiser messages as each chose', async () => {
    const [mine] = await threads(db, MANAGER_1);
    await sql(db, `select public.save_notification_preferences(null, 'off', null, null, 'off', 'both', 'immediate', true, '{}', 'off')`);
    await post(db, mine.id, 'Hello?', MANAGER_1);
    expect(await chat(db)).toEqual([]);
    await sql(db, `select public.save_notification_preferences(null, 'off', null, null, 'off', 'both', 'immediate', true, '{}', 'digest')`);
    await db.query(`select public.notify_message_digest($1)`, [OIZER]);
    const d = (await db.query<{ subject: string; body: string }>(`select subject, body from public.messages where kind = 'message_digest'`)).rows;
    expect(d[0].subject).toBe('Unread messages from fundraisers');
    expect(d[0].body).toContain('Manager One: 1 unread');
  });

  it('run a campaign group chat only once an admin turns it on', async () => {
    expect((await threads(db, MANAGER_1)).filter(t => t.kind === 'group')).toEqual([]);
    const g = (await one(db, `select public.set_group_chat('1003', true) id`)).id;
    const forM1 = (await threads(db, MANAGER_1)).find(t => t.kind === 'group');
    expect(forM1).toMatchObject({ title: 'Shared campaign (1003) group' });
    expect((await threads(db, MANAGER_2)).find(t => t.kind === 'group')).toBeTruthy();
    await post(db, g, 'Who is covering Sunday?', MANAGER_1);
    expect((await chat(db)).map(m => m.to_address)).toEqual(['office@example.org', 'two@example.org']);
    await sql(db, `select public.set_group_chat('1003', false)`);
    expect((await threads(db, MANAGER_1)).filter(t => t.kind === 'group')).toEqual([]);
    await expect(post(db, g, 'Still here?', MANAGER_1)).rejects.toThrow(/can't write/);
    expect(await rows(db, ADMIN, `select body from public.thread_history($1)`, [g])).toEqual([{ body: 'Who is covering Sunday?' }]);
  });

  it('keep voice messages of up to two minutes, playable by the conversation only', async () => {
    const [mine] = await threads(db, MANAGER_1);
    const id = (await one(db, `select public.post_message($1, null, $2, 'audio/webm', 14) id`, [mine.id, Buffer.from('fake audio').toString('base64')], MANAGER_1)).id;
    expect(await rows(db, ADMIN, `select mime, data from public.voice_note($1)`, [id])).toEqual([{ mime: 'audio/webm', data: Buffer.from('fake audio').toString('base64') }]);
    expect(await rows(db, MANAGER_2, `select * from public.voice_note($1)`, [id])).toEqual([]);
    expect((await threads(db, ADMIN))[0].last_preview).toBe('Voice message');
    await expect(sql(db, `select public.post_message($1, null, 'AAAA', 'audio/webm', 121)`, [mine.id], MANAGER_1)).rejects.toThrow(/up to 2 minutes/);
    await expect(sql(db, `select public.post_message($1, '  ')`, [mine.id], MANAGER_1)).rejects.toThrow(/Write a message/);
  });

  it('broadcast into each chosen fundraiser\'s conversation, where they can reply', async () => {
    const r = await one(db, `select public.send_broadcast('all', 'New payout process starting Monday') r`);
    expect(r.r.recipients).toBe(2);
    const [m2] = await threads(db, MANAGER_2);
    expect(m2).toMatchObject({ unread: 1, last_preview: 'New payout process starting Monday' });
    expect((await rows(db, MANAGER_2, `select broadcast from public.thread_history($1)`, [m2.id]))[0].broadcast).toBe(true);
    await post(db, m2.id, 'Thanks', MANAGER_2);
    expect(await one(db, `select recipient_count from public.broadcasts`)).toEqual({ recipient_count: 2 });
    await expect(sql(db, `select public.send_broadcast('chosen', 'x', '{}')`)).rejects.toThrow(/at least one fundraiser/);
    await expect(sql(db, `select public.send_broadcast('all', 'x')`, [], MANAGER_1)).rejects.toThrow();
  });

  it('pin one announcement at a time, emailed when first posted', async () => {
    await sql(db, `select public.post_announcement('System maintenance Sunday 2am')`);
    await sql(db, `select public.post_announcement('New payout process starting Monday')`);
    expect(await rows(db, MANAGER_1, `select body from public.announcements where removed_at is null`)).toEqual([{ body: 'New payout process starting Monday' }]);
    expect((await db.query(`select 1 from public.messages where kind = 'announcement'`)).rows).toHaveLength(4);
    await sql(db, `select public.remove_announcement()`);
    expect(await rows(db, MANAGER_1, `select body from public.announcements where removed_at is null`)).toEqual([]);
    await expect(sql(db, `select public.post_announcement('x')`, [], MANAGER_1)).rejects.toThrow();
  });

  it('let only the Super Admin change quick replies, and only admins see them', async () => {
    expect((await rows(db, ADMIN, `select body from public.quick_replies order by sort`)).map(r => r.body)[0]).toBe('Your campaign is ready');
    expect(await rows(db, MANAGER_1, `select * from public.quick_replies`)).toEqual([]);
    const superAdmin = await one(db, `select public.is_super_admin() s`);
    if (superAdmin.s) {
      await sql(db, `select public.save_quick_reply(null, 'On my way', 9)`);
      expect((await rows(db, ADMIN, `select body from public.quick_replies where body = 'On my way'`))).toHaveLength(1);
    } else {
      await expect(sql(db, `select public.save_quick_reply(null, 'On my way', 9)`)).rejects.toThrow(/Only the Super Admin/);
    }
  });
});
