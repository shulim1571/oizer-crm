import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, MANAGER_1, OIZER, rows, seededDb } from './harness';

const NUMBER = '+18456134272';
const M1_PHONE = '+17185550101';
const STRANGER = '+12125550199';

const svc = async <T = Record<string, any>>(db: PGlite, q: string, params: unknown[] = []) => (await rows<T>(db, 'service_role', q, params))[0];
const text = async (db: PGlite, from: string, body: string, to = NUMBER) =>
  (await svc<{ r: string | null }>(db, `select public.sms_lookup_reply($1, $2, $3) r`, [to, from, body])).r;
const lookup = async (db: PGlite, from: string, campaign: string | null, pin: string | null) =>
  (await svc<{ r: any }>(db, `select public.phone_lookup($1, 'voice', $2, $3, $4) r`, [OIZER, from, campaign, pin])).r;
const admin = (db: PGlite, q: string, params: unknown[] = []) => rows(db, ADMIN, q, params);

describe('phone and text lookup', () => {
  let base: PGlite;
  let db: PGlite;
  beforeAll(async () => {
    base = await seededDb();
    await base.exec(`
      update public.org_members set role = 'super_admin' where user_id = '${ADMIN}';
      insert into public.messaging_settings (org_id, sms_from) values ('${OIZER}', '${NUMBER}')
        on conflict (org_id) do update set sms_from = excluded.sms_from;
      update public.campaigns set pin = '4321' where id = '1002';
    `);
  });
  beforeEach(async () => { db = await base.clone(); });

  it('stays silent until the Super Admin turns text replies on', async () => {
    expect(await text(db, STRANGER, '1002 4321')).toBeNull();
    await admin(db, `select public.save_phone_lookup(true, false)`);
    expect(await text(db, STRANGER, '1002 4321')).toMatch(/^1002 .*Raised \$375\.00, Expenses \$0\.00, Balance/);
    expect(await text(db, STRANGER, '1002 4321', '+19995550000')).toBeNull();
    await db.query(`update public.org_members set role = 'admin' where user_id = $1`, [ADMIN]);
    await expect(admin(db, `select public.save_phone_lookup(false, false)`)).rejects.toThrow(/Only the Super Admin/);
  });

  it('answers a fundraiser’s registered phone about their own campaigns only', async () => {
    await admin(db, `select public.save_phone_lookup(true, true)`);
    expect(await admin(db, `select public.add_fundraiser_phone('m1', '(718) 555-0101') p`)).toEqual([{ p: M1_PHONE }]);
    const list = await text(db, M1_PHONE, 'bal');
    // m1 is primary on 1001 and secondary on 1003.
    expect(list?.split('\n').map(l => l.split(' ')[0])).toEqual(['1001', '1003', 'Text']);
    expect(await text(db, M1_PHONE, '1001')).toMatch(/^1001 First campaign: Raised \$1,250\.50/);
    expect(await text(db, M1_PHONE, '1002')).toBe('Text 1002 and its PIN, like: 1002 1234');
    expect(await text(db, STRANGER, 'bal')).toMatch(/Text a campaign number and its PIN/);
    expect(await text(db, M1_PHONE, 'thanks!')).toBeNull();
    expect(await text(db, M1_PHONE, 'STOP')).toBeNull();
    expect(await text(db, STRANGER, '9999 1234')).toMatch(/^No campaign with that number\. Text a campaign number and its PIN/);
  });

  it('forgives #, commas, a leading BAL and a PIN typed straight after the code', async () => {
    await admin(db, `select public.save_phone_lookup(true, false)`);
    const answer = /^1002 Second campaign: Raised \$375\.00/;
    // Shulim's first tries, from a phone that isn't registered.
    expect(await text(db, STRANGER, '1002#')).toBe('Text 1002 and its PIN, like: 1002 1234');
    expect(await text(db, STRANGER, '10022468')).toBe("That PIN doesn't match campaign 1002. Check it and text: 1002 and the PIN"); // read as 1002 + 2468, not 1002's PIN here
    expect(await text(db, STRANGER, '10024321')).toMatch(answer);
    expect(await text(db, STRANGER, '1002# 4321#')).toMatch(answer);
    expect(await text(db, STRANGER, 'Balance, 1002#, 4321')).toMatch(answer);
    expect(await text(db, STRANGER, 'Balance, 1002, 4321')).toMatch(answer);
    expect(await text(db, STRANGER, '1002, 4321')).toMatch(answer);
    expect(await text(db, STRANGER, 'bal 1002 4321')).toMatch(answer);
    expect(await text(db, STRANGER, '*1002*4321*')).toMatch(answer);
    // A code with a missing or garbled PIN gets the hint, never silence.
    expect(await text(db, STRANGER, 'Balance 1002')).toBe('Text 1002 and its PIN, like: 1002 1234');
    expect(await text(db, STRANGER, '1002 43x1')).toBe('Text 1002 and its PIN, like: 1002 1234');
    expect(await text(db, STRANGER, '1002 12')).toBe('Text 1002 and its PIN, like: 1002 1234');
    expect(await text(db, STRANGER, '1002 1111')).toBe("That PIN doesn't match campaign 1002. Check it and text: 1002 and the PIN");
    // The keyword alone from an unregistered phone explains how; chit-chat still gets nothing.
    expect(await text(db, STRANGER, 'Balance')).toMatch(/Text a campaign number and its PIN/);
    expect(await text(db, STRANGER, 'thanks!')).toBeNull();
    expect(await text(db, STRANGER, 'stop')).toBeNull();
    // A registered phone with nothing active is told how to look one up.
    await db.query(`update public.campaigns set status = 'archived' where id in ('1001', '1003')`);
    await admin(db, `select public.add_fundraiser_phone('m1', '7185550101')`);
    expect(await text(db, '+17185550101', 'BAL')).toBe('No active campaigns for this phone. To look one up, text its number and PIN, like: 1001 1234');
    expect(await text(db, '+17185550101', '1002#')).toBe('Text 1002 and its PIN, like: 1002 1234');
  });

  it('limits registered phones and keeps each phone with one fundraiser', async () => {
    for (const p of ['7185550101', '7185550102', '7185550103']) await admin(db, `select public.add_fundraiser_phone('m1', $1)`, [p]);
    await expect(admin(db, `select public.add_fundraiser_phone('m1', '7185550104')`)).rejects.toThrow(/up to 3 phones/);
    await expect(admin(db, `select public.add_fundraiser_phone('m2', '7185550101')`)).rejects.toThrow(/another fundraiser/);
    await expect(admin(db, `select public.add_fundraiser_phone('m2', '555')`)).rejects.toThrow(/area code/);
    await expect(rows(db, MANAGER_1, `select public.add_fundraiser_phone('m1', '7185550109')`)).rejects.toThrow(/Only admins/);
    await admin(db, `select public.remove_fundraiser_phone('m1', '+17185550103')`);
    expect((await admin(db, `select phone from public.fundraiser_phone_list('m1')`)).map(r => r.phone)).toEqual(['+17185550101', '+17185550102']);
  });

  it('recognizes the phone on the fundraiser’s record too', async () => {
    await db.query(`update public.managers set phone = '718-555-0177' where id = 'm2'`);
    expect(await lookup(db, '+17185550177', '1002', null)).toMatchObject({ outcome: 'answered', campaign: { id: '1002', balance: expect.any(Number) } });
  });

  it('checks the PIN, locks a phone after five wrong ones, and never logs a PIN', async () => {
    expect(await lookup(db, STRANGER, '1002', null)).toMatchObject({ outcome: 'needs_pin' });
    expect((await lookup(db, STRANGER, '1001', '0000')).outcome).toBe('wrong_pin'); // 1001 has no PIN: nobody gets in by PIN
    for (let i = 0; i < 4; i++) expect((await lookup(db, STRANGER, '1002', '1111')).outcome).toBe('wrong_pin');
    expect((await lookup(db, STRANGER, '1002', '4321')).outcome).toBe('locked');
    expect((await lookup(db, '+12125550100', '1002', '4321')).outcome).toBe('answered');
    await db.query(`update public.phone_lookups set at = at - interval '61 minutes'`);
    expect((await lookup(db, STRANGER, '1002', '4321')).outcome).toBe('answered');
    const logged = JSON.stringify((await db.query(`select * from public.phone_lookups`)).rows);
    expect(logged).not.toContain('4321');
    expect(logged).not.toContain('1111');
    const recent = await admin(db, `select outcome from public.recent_phone_lookups()`);
    expect(recent.length).toBe(9);
    await expect(rows(db, MANAGER_1, `select * from public.recent_phone_lookups()`)).resolves.toEqual([]);
  });

  it('keeps PINs to 4–8 digits and the lookup to the service', async () => {
    await expect(db.query(`update public.campaigns set pin = '12' where id = '1001'`)).rejects.toThrow();
    await expect(db.query(`update public.campaigns set pin = 'abcd' where id = '1001'`)).rejects.toThrow();
    await expect(rows(db, ADMIN, `select public.phone_lookup($1, 'sms', $2, '1002', '4321')`, [OIZER, STRANGER])).rejects.toThrow();
    await expect(rows(db, 'anon', `select public.sms_lookup_reply($1, $2, 'bal')`, [NUMBER, STRANGER])).rejects.toThrow();
  });

  it('shows the settings to admins with the organization’s number', async () => {
    expect(await admin(db, `select sms_replies, voice, sms_number from public.phone_lookup_status()`))
      .toEqual([{ sms_replies: false, voice: false, sms_number: NUMBER }]);
    expect((await svc(db, `select * from public.phone_org($1)`, ['(845) 613-4272']))).toMatchObject({ org_id: OIZER, voice: false });
  });
});
