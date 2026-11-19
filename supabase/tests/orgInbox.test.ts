import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, MANAGER_1, OIZER, rows, seededDb } from './harness';

// Per-organization inbox (Shulim, 2026-11-19): an address per organization, mail stored under the organization it
// was sent to, trusted and authentic senders go to review, everything else is kept as not trusted. Nothing posts.
const OTHER = '00000000-0000-4000-8000-0000000000bb';
const OTHER_ADMIN = '00000000-0000-0000-0000-0000000000b1';
const DOMAIN = 'inbox.example.test';
const q = <T = Record<string, any>>(db: PGlite, sql: string, params: unknown[] = [], who = ADMIN, org = OIZER) => rows<T>(db, who, sql, params, org);
const svc = <T = Record<string, any>>(db: PGlite, sql: string, params: unknown[] = []) => rows<T>(db, 'service_role', sql, params);
const meta = (over: Record<string, unknown> = {}) => JSON.stringify({ message_id: '<m1@ojcfund.org>', from_address: 'notifications@ojcfund.org',
  from_name: 'OJC Fund', subject: 'ACH Deposit', sent_at: '2026-11-19T15:00:00Z', envelope_from: 'bounce@ojcfund.org', size_bytes: 4200,
  spam_score: 0.1, spf: 'pass', dkim: '{@ojcfund.org : pass}', ...over });

async function receive(db: PGlite, local: string, m = meta(), authentic = true, confirm = false) {
  const [r] = await svc<{ org_id: string | null; email_id: string | null; retry: boolean; outcome: string }>(db, `select * from public.inbox_receive($1, $2::jsonb)`, [local, m]);
  if (!r.email_id) return { ...r, status: null as string | null };
  const [{ s }] = await svc<{ s: string }>(db, `select public.inbox_finish($1, $2, $3, $4, $5, $6, $7::jsonb, $8) s`,
    [r.org_id, r.email_id, `${r.org_id}/${r.email_id}/message.eml`, 'Sample body', authentic, authentic ? 'DKIM pass, aligned' : 'no aligned pass',
     JSON.stringify([{ filename: 'ACH.pdf', mime: 'application/pdf', size_bytes: 1000, sha256: 'ab', storage_path: `${r.org_id}/${r.email_id}/1-ACH.pdf` }]), confirm]);
  return { ...r, status: s };
}

describe('organization inbox', () => {
  let base: PGlite;
  let db: PGlite;
  beforeAll(async () => {
    base = await seededDb();
    await base.exec(`
      update public.org_members set role = 'super_admin' where user_id = '${ADMIN}';
      insert into public.platform_config (key, value) values ('inbox_domain', '${DOMAIN}');
      insert into public.organizations (id, slug, name) values ('${OTHER}', 'other', 'Other Org');
      insert into auth.users (id, email) values ('${OTHER_ADMIN}', 'admin@other.org');
      insert into public.org_members (org_id, user_id, role) values ('${OTHER}', '${OTHER_ADMIN}', 'super_admin');`);
  });
  beforeEach(async () => { db = await base.clone(); });
  const newAddress = async (who = ADMIN, org = OIZER) => (await q<{ a: string }>(db, `select public.inbox_new_address() a`, [], who, org))[0].a;
  const local = (address: string) => address.split('@')[0];

  it('gives each organization its own random address at the inbox domain, and only inbox managers may', async () => {
    const a = await newAddress();
    const [user, host, ...rest] = a.split('@');
    expect(user).toMatch(/^[a-z0-9]{20}$/);
    expect(host).toBe(DOMAIN);
    expect(rest).toEqual([]);
    expect((await q(db, `select address, status from public.inbox_status()`))[0]).toEqual({ address: a, status: 'active' });
    const b = await newAddress(OTHER_ADMIN, OTHER);
    expect(local(b)).not.toBe(local(a));
    await expect(q(db, `select public.inbox_new_address()`, [], MANAGER_1)).rejects.toThrow(/manage the inbox/);
    await expect(q(db, `select * from public.inbox_status()`, [], MANAGER_1)).rejects.toThrow(/manage the inbox/);
  });

  it('stores mail under the organization the address belongs to, and sends a trusted, authentic sender to review', async () => {
    const a = await newAddress();
    const b = await newAddress(OTHER_ADMIN, OTHER);
    await q(db, `insert into public.inbox_trusted_senders (pattern, report_type, label) values ('@ojcfund.org', 'ojc_ach', 'OJC')`);
    const r = await receive(db, local(a));
    expect(r).toMatchObject({ org_id: OIZER, outcome: 'new', status: 'to_review' });
    const [e] = await q(db, `select report_type, authentic, complete, raw_path from public.inbound_emails where id = $1`, [r.email_id]);
    expect(e).toMatchObject({ report_type: 'ojc_ach', authentic: true, complete: true });
    const [task] = (await db.query(`select task_type, resolved_at from public.task_items where task_key = $1`, [`inbox_review:${r.email_id}`])).rows as any[];
    expect(task).toMatchObject({ task_type: 'inbox_review', resolved_at: null });
    expect((await q(db, `select count(*)::int n from public.inbound_attachments where email_id = $1`, [r.email_id]))[0].n).toBe(1);
    // The other organization sees nothing of it, and Oizer's trusted list doesn't apply to it.
    expect(await q(db, `select id from public.inbound_emails`, [], OTHER_ADMIN, OTHER)).toEqual([]);
    const r2 = await receive(db, local(b), meta({ message_id: '<m2@ojcfund.org>' }));
    expect(r2).toMatchObject({ org_id: OTHER, status: 'not_trusted' });
  });

  it('keeps mail from an untrusted or unauthenticated sender as not trusted, with no review item', async () => {
    const a = await newAddress();
    await q(db, `insert into public.inbox_trusted_senders (pattern, report_type) values ('notifications@ojcfund.org', 'ojc_ach')`);
    const forged = await receive(db, local(a), meta({ message_id: '<f@x>' }), false);
    const stranger = await receive(db, local(a), meta({ message_id: '<s@x>', from_address: 'someone@else.example' }));
    expect([forged.status, stranger.status]).toEqual(['not_trusted', 'not_trusted']);
    expect((await db.query(`select count(*)::int n from public.task_items where task_type = 'inbox_review'`)).rows[0]).toEqual({ n: 0 });
    // Trusting the sender from the message sends it to review.
    await q(db, `select public.inbox_trust_sender($1, 'other')`, [stranger.email_id]);
    expect((await q(db, `select status from public.inbound_emails where id = $1`, [stranger.email_id]))[0].status).toBe('to_review');
  });

  it('always shows a Gmail forwarding confirmation, so the admin can copy the code', async () => {
    const a = await newAddress();
    const r = await receive(db, local(a), meta({ message_id: '<g@google>', from_address: 'forwarding-noreply@google.com', subject: 'Gmail Forwarding Confirmation' }), true, true);
    expect(r.status).toBe('to_review');
  });

  it('flags a second copy as a possible duplicate instead of skipping it, and a retry reuses the unfinished row', async () => {
    const a = await newAddress();
    await q(db, `insert into public.inbox_trusted_senders (pattern, report_type) values ('@ojcfund.org', 'ojc_ach')`);
    const first = await receive(db, local(a));
    const again = await receive(db, local(a));
    expect(again).toMatchObject({ outcome: 'possible_duplicate', status: 'possible_duplicate' });
    expect((await q(db, `select duplicate_of from public.inbound_emails where id = $1`, [again.email_id]))[0].duplicate_of).toBe(first.email_id);
    await q(db, `select public.inbox_review($1, 'not_duplicate')`, [again.email_id]);
    expect((await q(db, `select status, duplicate_of from public.inbound_emails where id = $1`, [again.email_id]))[0]).toEqual({ status: 'to_review', duplicate_of: null });
    // A message whose files didn't finish storing comes back to the same row when SendGrid retries.
    const [half] = await svc(db, `select * from public.inbox_receive($1, $2::jsonb)`, [local(a), meta({ message_id: '<half@x>' })]);
    const [retry] = await svc(db, `select * from public.inbox_receive($1, $2::jsonb)`, [local(a), meta({ message_id: '<half@x>' })]);
    expect(retry).toMatchObject({ email_id: half.email_id, retry: true, outcome: 'retry' });
  });

  it('keeps a replaced address working for 14 days, refuses a turned-off one, and refuses unknown ones', async () => {
    const old = await newAddress();
    const fresh = await newAddress();
    expect((await receive(db, local(old))).org_id).toBe(OIZER);
    expect((await q(db, `select old_address from public.inbox_status()`))[0].old_address).toBe(old);
    await db.query(`update public.org_inboxes set accept_until = now() - interval '1 minute' where local_part = $1`, [local(old)]);
    expect((await receive(db, local(old), meta({ message_id: '<late@x>' }))).outcome).toBe('unknown_address');
    await q(db, `select public.inbox_turn_off()`);
    expect((await receive(db, local(fresh), meta({ message_id: '<off@x>' }))).outcome).toBe('unknown_address');
    expect((await receive(db, 'nosuchaddress', meta({ message_id: '<u@x>' }))).outcome).toBe('unknown_address');
  });

  it('stops keeping mail past the daily limit and says so on the Task Sheet', async () => {
    const a = await newAddress();
    await q(db, `insert into public.inbox_settings (daily_cap) values (10)`);
    for (let i = 0; i < 10; i++) await receive(db, local(a), meta({ message_id: `<c${i}@x>` }));
    expect((await receive(db, local(a), meta({ message_id: '<c10@x>' }))).outcome).toBe('over_cap');
    expect((await db.query(`select count(*)::int n from public.task_items where task_type = 'inbox_cap'`)).rows[0]).toEqual({ n: 1 });
  });

  it('closes a review without changing anything in the books', async () => {
    const a = await newAddress();
    await q(db, `insert into public.inbox_trusted_senders (pattern, report_type) values ('@ojcfund.org', 'ojc_ach')`);
    const r = await receive(db, local(a));
    const before = (await db.query(`select count(*)::int n from public.donations`)).rows[0];
    await q(db, `select public.inbox_review($1, 'reviewed', 'Matched by hand')`, [r.email_id]);
    expect((await q(db, `select status, review_note from public.inbound_emails where id = $1`, [r.email_id]))[0]).toEqual({ status: 'reviewed', review_note: 'Matched by hand' });
    expect((await db.query(`select resolved_at is not null done from public.task_items where task_key = $1`, [`inbox_review:${r.email_id}`])).rows[0]).toEqual({ done: true });
    expect((await db.query(`select count(*)::int n from public.donations`)).rows[0]).toEqual(before);
    await expect(q(db, `select public.inbox_review($1, 'reviewed')`, [r.email_id], MANAGER_1)).rejects.toThrow(/manage the inbox/);
  });

  it('keeps the receiving functions away from signed-in users', async () => {
    await expect(q(db, `select * from public.inbox_receive('x', '{}'::jsonb)`)).rejects.toThrow();
    await expect(q(db, `select public.inbox_finish(null, null, null, null, true, null, '[]'::jsonb, false)`)).rejects.toThrow();
    await expect(q(db, `select * from public.platform_config`)).rejects.toThrow();
  });
});
