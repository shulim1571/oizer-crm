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

  describe('RECENT and leaving out Donary', () => {
    const ADMIN_PHONE = '+18455550111';
    const add = (id: string, campaign: string, amount: number, extra: { donary?: string; status?: string; at?: string; name?: string; anonymous?: boolean } = {}) =>
      svc(db, `insert into public.donations (id, org_id, campaign_id, type, status, amount, name, anonymous, donary_id, created_at)
               values ($1, $2, $3, 'Payment', $4, $5, $6, $7, $8, $9)`,
        [id, OIZER, campaign, extra.status ?? 'completed', amount, extra.name ?? 'Chaim Weiss', extra.anonymous ?? false, extra.donary ?? null, extra.at ?? '2030-01-01T15:00:00Z']);
    const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    beforeEach(async () => {
      await admin(db, `select public.save_phone_lookup(true, false)`);
      await admin(db, `select public.add_fundraiser_phone('m1', '(718) 555-0101')`);
      await svc(db, `insert into public.notification_preferences (org_id, user_id, phone) values ($1, $2, '(845) 555-0111')`, [OIZER, ADMIN]);
      await add('r1', '1001', 180, { at: '2030-01-01T16:00:00Z', name: 'Moshe Klein' });
      await add('r2', '1002', 36, { at: '2030-01-01T17:00:00Z', anonymous: true });
      await add('r3', '1001', 54, { at: '2030-01-01T18:00:00Z', donary: 'DN-1', name: 'Yossi Gold' });
      await add('r4', '1001', 99, { at: '2030-01-01T19:00:00Z', status: 'failed' });
    });

    it('lists an admin’s latest transactions across campaigns, with the donor’s full name, newest first', async () => {
      const r = await text(db, ADMIN_PHONE, 'recent');
      const lines = r!.split('\n');
      expect(lines[0]).toBe('Recent:');
      expect(lines.slice(1, 4)).toEqual(['1/1 $54.00 #1001 Yossi Gold', '1/1 $36.00 #1002 Anon', '1/1 $180.00 #1001 Moshe Klein']);
      expect(lines.length).toBeLessThanOrEqual(6);
      expect(r).not.toContain('$99.00');           // a failed charge isn't listed
      expect(r).not.toMatch(/\(845\)|@/);          // names only: no phones or emails
      const one = (await text(db, ADMIN_PHONE, 'Recent 1002'))!.split('\n');
      expect(one.slice(0, 2)).toEqual(['Recent for #1002:', '1/1 $36.00 #1002 Anon']);
      expect(one.slice(1).every(l => l.includes('#1002'))).toBe(true);
    });

    it('shows a fundraiser only their own campaigns', async () => {
      const r = await text(db, M1_PHONE, 'RECENT');
      expect(r).toContain('#1001');
      expect(r).not.toContain('#1002');            // m1 isn't on 1002
      expect(await text(db, M1_PHONE, 'recent 1002')).toBe('No campaign 1002 for this phone.');
    });

    it('answers an unknown phone politely once a day, then not at all', async () => {
      expect(await text(db, STRANGER, 'recent')).toMatch(/isn't registered for RECENT/);
      expect(await text(db, STRANGER, 'recent')).toBeNull();
      expect(await text(db, STRANGER, 'recent 1001')).toBeNull();
    });

    it('allows 10 an hour per phone, then one notice and silence', async () => {
      for (let i = 0; i < 10; i++) expect(await text(db, M1_PHONE, 'recent')).toMatch(/^Recent:/);
      expect(await text(db, M1_PHONE, 'recent')).toMatch(/Too many RECENT texts/);
      expect(await text(db, M1_PHONE, 'recent')).toBeNull();
      // Balance lookups aren't affected.
      expect(await text(db, M1_PHONE, '1001')).toMatch(/^1001 /);
    });

    it('stays silent while text replies are off', async () => {
      await admin(db, `select public.save_phone_lookup(false, false)`);
      expect(await text(db, ADMIN_PHONE, 'recent')).toBeNull();
    });

    it('leaves Donary donations out of every automatic reply when the setting is on (off by default)', async () => {
      expect(await admin(db, `select exclude_donary from public.phone_lookup_status()`)).toEqual([{ exclude_donary: false }]);
      const before = await lookup(db, M1_PHONE, '1001', null);
      expect(await text(db, ADMIN_PHONE, 'recent 1001')).toContain('Yossi Gold');

      await admin(db, `select public.save_phone_lookup(true, false, true)`);
      expect(await admin(db, `select exclude_donary from public.phone_lookup_status()`)).toEqual([{ exclude_donary: true }]);
      const after = await lookup(db, M1_PHONE, '1001', null);
      expect(Number(after.campaign.raised)).toBeCloseTo(Number(before.campaign.raised) - 54, 2);
      expect(Number(after.campaign.balance)).toBeCloseTo(Number(before.campaign.balance) - 54, 2);
      expect(await text(db, M1_PHONE, '1001')).toContain(`Raised $${money(Number(before.campaign.raised) - 54)}`);
      expect(await text(db, ADMIN_PHONE, 'recent 1001')).not.toContain('Yossi Gold');
      expect(await text(db, M1_PHONE, 'bal')).toMatch(/^1001 /);
      // Saving the switches without the new setting keeps it as it was; only the Super Admin can change it.
      await admin(db, `select public.save_phone_lookup(true, true)`);
      expect(await admin(db, `select exclude_donary from public.phone_lookup_status()`)).toEqual([{ exclude_donary: true }]);
      await expect(rows(db, MANAGER_1, `select public.save_phone_lookup(true, true, false)`)).rejects.toThrow();
    });
  });
});
