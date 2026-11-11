import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, MANAGER_1, OIZER, as, rows, seededDb } from './harness';

// Two-step verification by text or call (Shulim, 2026-11-11). Codes are hashed, 10-minute, single-use, 5 tries;
// 5 sends an hour per user and per phone; a correct code verifies only the session that asked for it, and that
// counts exactly like an authenticator-app session for bank data.
const S1 = '00000000-0000-4000-a000-0000000000a1';
const S2 = '00000000-0000-4000-a000-0000000000a2';
const PHONE = '(845) 555-0177';
const NORMAL = '+18455550177';

// Everything as ADMIN in a password-only session (aal1) with a given session id.
const asUser = <T = Record<string, any>>(db: PGlite, session: string, q: string, params: unknown[] = [], user = ADMIN) =>
  as(db, user, async tx => (await tx.query<T>(q, params)).rows, undefined, 'aal1', session);
const start = async (db: PGlite, session: string, purpose: 'enroll' | 'signin', channel = 'sms', phone: string | null = PHONE, user = ADMIN) =>
  (await asUser(db, session, `select * from public.mfa_phone_start($1, $2, $3)`, [purpose, channel, phone], user))[0] as { challenge_id: string; phone_masked: string };
const issue = async (db: PGlite, id: string) => (await rows(db, 'service_role', `select * from public.mfa_phone_issue($1)`, [id]))[0];
const verify = async (db: PGlite, session: string, id: string, code: string, user = ADMIN) =>
  (await asUser(db, session, `select public.mfa_phone_verify($1, $2) as r`, [id, code], user))[0].r as string;
const enroll = async (db: PGlite, session = S1) => {
  const c = await start(db, session, 'enroll');
  const sent = await issue(db, c.challenge_id);
  expect(await verify(db, session, c.challenge_id, sent.code)).toBe('ok');
};

describe('two-step verification by text or call', () => {
  let base: PGlite;
  let db: PGlite;
  beforeAll(async () => {
    base = await seededDb();
    await base.query(`update public.org_members set role = 'super_admin' where user_id = $1`, [ADMIN]);
    await base.query(`insert into public.accounts (org_id, id, name) values ($1, 'a1', 'Operating') on conflict do nothing`, [OIZER]);
    await base.query(`insert into public.bank_lines (org_id, account_id, posted_date, amount, fingerprint, source) values ($1, 'a1', '2026-11-02', 50, 'p1', 'import')`, [OIZER]);
  });
  beforeEach(async () => { db = await base.clone(); });

  it('lets a Super Admin add their own phone, and a verified code unlocks bank data for that session like TOTP', async () => {
    expect((await asUser(db, S1, `select count(*)::int as n from public.bank_lines`))[0].n).toBe(0);
    const c = await start(db, S1, 'enroll', 'call');
    expect(c.phone_masked).toBe('•••-•••-0177');
    const sent = await issue(db, c.challenge_id);
    expect(sent).toMatchObject({ phone: NORMAL, channel: 'call', purpose: 'enroll' });
    expect(sent.code).toMatch(/^\d{6}$/);
    // Only the hash is kept.
    const [stored] = (await db.query<Record<string, any>>(`select code_hash from public.mfa_phone_codes where id = $1`, [c.challenge_id])).rows;
    expect(stored.code_hash).toMatch(/^\$2[aby]\$/);
    expect(stored.code_hash).not.toContain(sent.code);
    // A code is issued once, and never to the app.
    expect(await issue(db, c.challenge_id)).toBeUndefined();
    await expect(asUser(db, S1, `select * from public.mfa_phone_issue($1)`, [c.challenge_id])).rejects.toThrow();

    expect(await verify(db, S1, c.challenge_id, sent.code)).toBe('ok');
    expect(await asUser(db, S1, `select phone_masked, channel, verified, session_verified from public.mfa_phone_status()`))
      .toEqual([{ phone_masked: '•••-•••-0177', channel: 'call', verified: true, session_verified: true }]);
    expect((await asUser(db, S1, `select count(*)::int as n from public.bank_lines`))[0].n).toBe(1);
    expect((await asUser(db, S1, `select public.plaid_admin_check('a1') as org`))[0].org).toBe(OIZER);
  });

  it('binds a code to the session that asked for it; another session stays unverified', async () => {
    await enroll(db, S1);
    expect((await asUser(db, S2, `select public.mfa_ok() as ok`))[0].ok).toBe(false);
    const c = await start(db, S1, 'signin');
    const sent = await issue(db, c.challenge_id);
    expect(await verify(db, S2, c.challenge_id, sent.code)).toBe('not_found');   // used from another session
    expect((await asUser(db, S2, `select count(*)::int as n from public.bank_lines`))[0].n).toBe(0);
    // Someone else can't use it either.
    expect(await verify(db, S1, c.challenge_id, sent.code, MANAGER_1)).toBe('not_found');
    // The asking session gets a new code at sign-in and is verified.
    const c2 = await start(db, S2, 'signin', 'sms', null);
    expect(await verify(db, S2, c2.challenge_id, (await issue(db, c2.challenge_id)).code)).toBe('ok');
    expect((await asUser(db, S2, `select public.mfa_ok() as ok`))[0].ok).toBe(true);
  });

  it('accepts a code once only', async () => {
    const c = await start(db, S1, 'enroll');
    const sent = await issue(db, c.challenge_id);
    expect(await verify(db, S1, c.challenge_id, sent.code)).toBe('ok');
    expect(await verify(db, S1, c.challenge_id, sent.code)).toBe('used');
  });

  it('expires a code after 10 minutes', async () => {
    const c = await start(db, S1, 'enroll');
    const sent = await issue(db, c.challenge_id);
    const [life] = (await db.query<Record<string, any>>(`select extract(epoch from (expires_at - created_at))::int as s from public.mfa_phone_codes where id = $1`, [c.challenge_id])).rows;
    expect(life.s).toBe(600);
    await db.query(`update public.mfa_phone_codes set expires_at = now() - interval '1 second' where id = $1`, [c.challenge_id]);
    expect(await verify(db, S1, c.challenge_id, sent.code)).toBe('expired');
  });

  it('ends a code after 5 wrong tries, even if the right code comes next, and counts every try', async () => {
    const c = await start(db, S1, 'enroll');
    const sent = await issue(db, c.challenge_id);
    const wrong = sent.code === '000000' ? '111111' : '000000';
    for (let i = 1; i <= 4; i++) expect(await verify(db, S1, c.challenge_id, wrong)).toBe('wrong');
    expect(await verify(db, S1, c.challenge_id, wrong)).toBe('locked');
    expect(await verify(db, S1, c.challenge_id, sent.code)).toBe('locked');
    expect((await asUser(db, S1, `select public.mfa_ok() as ok`))[0].ok).toBe(false);
  });

  it('sends at most 5 codes an hour per user, and 5 an hour to one phone across users', async () => {
    for (let i = 0; i < 5; i++) await start(db, S1, 'enroll');
    await expect(start(db, S1, 'enroll')).rejects.toThrow(/Too many codes requested/);
    // A different person can't push the same phone past its limit either.
    await expect(start(db, S2, 'enroll', 'sms', PHONE, MANAGER_1)).rejects.toThrow(/Too many codes sent to this phone/);
    // An hour later it's open again.
    await db.query(`update public.mfa_phone_codes set created_at = created_at - interval '61 minutes'`);
    expect((await start(db, S1, 'enroll')).challenge_id).toBeTruthy();
  });

  it('needs a verified session to change or remove a verified phone; TOTP sessions count too', async () => {
    await enroll(db, S1);
    await expect(start(db, S2, 'enroll', 'sms', '(845) 555-0199')).rejects.toThrow(/Verify this session/);
    await expect(asUser(db, S2, `select public.mfa_phone_remove()`)).rejects.toThrow(/Verify this session/);
    // A session verified with the authenticator app (aal2) may change it.
    await as(db, ADMIN, tx => tx.query(`select * from public.mfa_phone_start('enroll', 'sms', '(845) 555-0199')`), undefined, 'aal2', S2);
    await asUser(db, S1, `select public.mfa_phone_remove()`);
    expect((await asUser(db, S1, `select verified from public.mfa_phone_status()`))[0].verified).toBe(false);
  });

  it('logs sends, verifications and failures without the code', async () => {
    const c = await start(db, S1, 'enroll');
    const sent = await issue(db, c.challenge_id);
    await verify(db, S1, c.challenge_id, sent.code === '000000' ? '111111' : '000000');
    await verify(db, S1, c.challenge_id, sent.code);
    const log = (await db.query<Record<string, any>>(`select action, changes from public.activity_log where action like 'mfa_%' order by id`)).rows;
    expect(log.map(l => l.action)).toEqual(['mfa_code_sent', 'mfa_code_failed', 'mfa_phone_added', 'mfa_code_verified']);
    expect(JSON.stringify(log)).not.toContain(sent.code);
  });

  it('end to end: sends and verifies the exact code for enrolling, then for signing in from a new session', async () => {
    // Enroll: the code the database issued for sending is the one that verifies.
    const e1 = await start(db, S1, 'enroll', 'sms', '845-555-0177');
    const sentEnroll = await issue(db, e1.challenge_id);
    expect(await verify(db, S1, e1.challenge_id, sentEnroll.code)).toBe('ok');
    // The same code typed with spaces or a dash still works only once.
    expect(await verify(db, S1, e1.challenge_id, `${sentEnroll.code.slice(0, 3)} ${sentEnroll.code.slice(3)}`)).toBe('used');
    // Sign in later from a new session, by call this time.
    const s1 = await start(db, S2, 'signin', 'call', null);
    const sentSignin = await issue(db, s1.challenge_id);
    expect(sentSignin).toMatchObject({ phone: NORMAL, channel: 'call', purpose: 'signin' });
    expect(await verify(db, S2, s1.challenge_id, `${sentSignin.code.slice(0, 3)}-${sentSignin.code.slice(3)}`)).toBe('ok');
    expect((await asUser(db, S2, `select public.mfa_ok() as ok`))[0].ok).toBe(true);
  });
});
