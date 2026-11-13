import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, MANAGER_1, OIZER, rows, seededDb } from './harness';

const GUID = '115e9d3d-baf2-4089-b896-9b2621ffcf1b';
const KEY = 'donary-test-key-0001';
const svc = async <T = Record<string, any>>(db: PGlite, q: string, params: unknown[] = []) => (await rows<T>(db, 'service_role', q, params))[0];
const admin = (db: PGlite, q: string, params: unknown[] = []) => rows(db, ADMIN, q, params);
const token = async (db: PGlite) => (await db.query<{ t: string }>(`select webhook_token t from public.donary_settings`)).rows[0].t;
const ingest = async (db: PGlite, event: string, payload: unknown, t?: string) =>
  (await svc<{ r: any }>(db, `select public.donary_ingest($1, $2, $3) r`, [t ?? await token(db), event, JSON.stringify(payload)])).r;
const waiting = async (db: PGlite) =>
  (await db.query<{ k: string }>(`select kind || ':' || ref_id k from public.donary_outbox where sent_at is null and not given_up order by id`)).rows.map(r => r.k);

// Shaped like Donary's documented examples.
const charge = (over: Record<string, unknown> = {}) => ({
  orgGuid: GUID, donorInfo: { donorNumber: 'd1', newDonor: null }, campaignInfo: [{ campaignNumber: 1001, campaignName: 'First' }],
  reasonInfo: [], collectorInfo: {}, locationInfo: {}, processedDateTime: '2026-11-08T21:01:14.44', amount: 18, token: 'tok_x',
  maskedAPIKey: 'pk_t****I7jx', gatewayName: 'Cardknox', last4Digits: '4242', brand: 'VISA', paymentNumber: '1238',
  gatewayRefNum: 'ref_1238', paymentMethod: 'Credit_Card', currency: 'USD', deviceName: 'DNRY-77', deviceCreatedDate: '2026-11-08T16:01:09.827',
  timezone: 'Eastern Standard Time', paymentStatus: 'Success', cardHolderName: 'Donor One', isAnonymousDonation: false, ...over,
});

describe('Donary Enterprise', () => {
  let base: PGlite;
  let db: PGlite;
  beforeAll(async () => {
    base = await seededDb();
    await base.exec(`update public.org_members set role = 'super_admin' where user_id = '${ADMIN}';`);
  });
  beforeEach(async () => { db = await base.clone(); });
  const connect = (d: PGlite) => admin(d, `select public.save_donary_settings(true, $1, $2)`, [GUID, KEY]);

  describe('settings', () => {
    it('need the orgGuid and key, keep the key encrypted, and are the Super Admin’s', async () => {
      await expect(admin(db, `select public.save_donary_settings(true, null, null)`)).rejects.toThrow(/orgGuid and API key/);
      await expect(admin(db, `select public.save_donary_settings(false, 'nope', null)`)).rejects.toThrow(/looks like/);
      await connect(db);
      const raw = (await db.query<{ k: string }>(`select encode(api_key, 'escape') k from public.donary_settings`)).rows[0].k;
      expect(raw).not.toContain(KEY);
      const status = (await admin(db, `select public.donary_status() s`))[0].s;
      expect(status).toMatchObject({ enabled: true, org_guid: GUID, api_key_set: true, waiting: 0 });
      expect(status.webhook_token).toHaveLength(48);
      await db.query(`update public.org_members set role = 'admin' where user_id = $1`, [ADMIN]);
      expect((await admin(db, `select public.donary_status() s`))[0].s.webhook_token).toBeNull();
      await expect(admin(db, `select public.save_donary_settings(false, null, null)`)).rejects.toThrow(/Only the Super Admin/);
      expect((await rows(db, MANAGER_1, `select public.donary_status() s`))[0].s).toBeNull();
    });
  });

  describe('sending lists to Donary', () => {
    it('queue nothing while off, then each change once', async () => {
      await db.query(`update public.donors set first_name = 'Changed' where id = 'd1'`);
      expect(await waiting(db)).toEqual([]);
      await connect(db);
      await db.query(`update public.donors set first_name = 'Again' where id = 'd1'`);
      await db.query(`update public.donors set first_name = 'Once more' where id = 'd1'`);
      await db.query(`update public.donors set notes = 'not sent to Donary' where id = 'd2'`);
      await db.query(`insert into public.collectors (org_id, id, first_name, last_name) values ($1, 'k1', 'Dovid', 'Feld')`, [OIZER]);
      await db.query(`insert into public.campaigns (org_id, id, internal_name, external_name, manager_id, parent_campaign_id) values ($1, '1004', 'Gold', 'Gold Page', 'm1', '1001')`, [OIZER]);
      expect(await waiting(db)).toEqual(['donor:d1', 'collector:k1', 'reason:1004']);
    });

    it('build payloads as Donary documents them', async () => {
      await connect(db);
      await db.query(`update public.donors set english_title = 'Mr.', phone = '(718) 555-0101', email = 'one@donor.org', address = '1 Main St',
        yiddish_first_name = 'משה', yiddish_last_name = 'כהן' where id = 'd1'`);
      expect((await svc(db, `select public.donary_payload($1, 'donor', 'd1') p`, [OIZER])).p).toEqual({
        orgGuid: GUID, donorId: 'd1', title: 'Mr.', firstName: 'Donor', lastName: 'One', firstNameHebrew: 'משה', lastNameHebrew: 'כהן',
        donorPhones: [{ phoneLabel: 'Main', phoneNumber: '7185550101', countryCode: 'USA' }],
        donorEmails: [{ emailLabel: 'Main', emailAddress: 'one@donor.org' }],
        donorAddresses: [{ addressLabel: 'Main', streetName: '1 Main St', country: 'United States' }],
      });
      // No phone on file: the list isn't sent, so Donary keeps what it has.
      expect(Object.keys((await svc(db, `select public.donary_payload($1, 'donor', 'd2') p`, [OIZER])).p)).not.toContain('donorPhones');
      expect((await svc(db, `select public.donary_payload($1, 'campaign', '1001') p`, [OIZER])).p)
        .toEqual({ orgGuid: GUID, campaignNumber: 1001, campaignName: 'First campaign', campaignFriendlyName: 'First campaign' });
      await db.query(`insert into public.campaigns (org_id, id, internal_name, manager_id, parent_campaign_id) values ($1, '1004', 'Gold', 'm1', '1001')`, [OIZER]);
      expect((await svc(db, `select public.donary_payload($1, 'reason', '1004') p`, [OIZER])).p)
        .toEqual({ orgGuid: GUID, reasonNumber: 1004, reasonName: 'Gold', campaignNum: 1001 });
    });

    it('send campaigns before their reasons, retry failures, and stop on records Donary can’t take', async () => {
      await connect(db);
      await db.query(`insert into public.campaigns (org_id, id, internal_name, manager_id, parent_campaign_id) values ($1, '1004', 'Gold', 'm1', '1001')`, [OIZER]);
      await db.query(`update public.campaigns set internal_name = 'First (renamed)' where id = '1001'`);
      await db.query(`insert into public.donors (org_id, id) values ($1, 'nameless')`, [OIZER]);
      const claimed = await rows(db, 'service_role', `select kind, ref_id, api_key, payload is not null p from public.donary_claim(10)`);
      expect(claimed.map(c => `${c.kind}:${c.ref_id}`)).toEqual(['campaign:1001', 'reason:1004']);
      expect(claimed[0].api_key).toBe(KEY);
      // The nameless donor was set aside with the reason; claimed items aren't handed out twice.
      expect(await rows(db, 'service_role', `select * from public.donary_claim(10)`)).toEqual([]);
      const stuck = (await admin(db, `select public.donary_status() s`))[0].s;
      expect(stuck.problems).toEqual([expect.objectContaining({ kind: 'donor', ref_id: 'nameless', given_up: true, error: expect.stringMatching(/first and last name/) })]);
      const ids = (await db.query<{ id: number; kind: string }>(`select id, kind from public.donary_outbox where kind in ('campaign','reason') order by kind`)).rows;
      await svc(db, `select public.donary_sent($1, true, null)`, [ids[0].id]);
      await svc(db, `select public.donary_sent($1, false, 'HTTP 503')`, [ids[1].id]);
      const r = (await db.query<{ next: boolean; given_up: boolean }>(`select next_try > now() + interval '4 minutes' next, given_up from public.donary_outbox where id = $1`, [ids[1].id])).rows[0];
      expect(r).toEqual({ next: true, given_up: false });
      expect(await waiting(db)).toEqual(['reason:1004']);
      await expect(rows(db, ADMIN, `select * from public.donary_claim(10)`)).rejects.toThrow();
    });

    it('queue everything for the first sync', async () => {
      await expect(admin(db, `select public.donary_queue_all()`)).rejects.toThrow(/Turn the Donary connection on/);
      await connect(db);
      expect((await admin(db, `select public.donary_queue_all() n`))[0].n).toBe(3 + 2);  // 3 campaigns, 2 donors, no collectors
    });
  });

  describe('webhooks from Donary', () => {
    it('turn away unknown tokens and anything while off', async () => {
      await connect(db);
      expect(await ingest(db, 'charge', charge(), 'x'.repeat(48))).toBeNull();
      await admin(db, `select public.save_donary_settings(false, null, null)`);
      expect(await ingest(db, 'charge', charge())).toBeNull();
      await expect(rows(db, 'anon', `select public.donary_ingest('t', 'charge', '{}')`)).rejects.toThrow();
    });

    it('record a charge once as a donation, on the machine’s source', async () => {
      await connect(db);
      await db.query(`insert into public.machines (org_id, nickname, donary_id, source_id) values ($1, 7, 'DNRY-77', 's1')`, [OIZER]);
      const r = await ingest(db, 'charge', charge());
      expect(r.status).toBe('recorded');
      const d = (await db.query(`select campaign_id, donor_id, amount::text, status, payment_method, source, donary_id, gateway_id, created_at, notes from public.donations where id = $1`, [r.donation_id])).rows[0];
      expect(d).toMatchObject({ campaign_id: '1001', donor_id: 'd1', amount: '18.00', status: 'completed', payment_method: 'Credit Card',
        source: 's1', donary_id: '1238', gateway_id: 'ref_1238', notes: 'Donary · DNRY-77 · VISA 4242' });
      expect(new Date(d.created_at as string).toISOString()).toBe('2026-11-08T21:01:14.440Z');
      expect(await ingest(db, 'charge', charge())).toEqual({ status: 'duplicate' });
      expect((await db.query(`select count(*)::int n from public.donations where donary_id = '1238'`)).rows[0]).toEqual({ n: 1 });
    });

    it('add a donor made on the device, and use a reason’s sub-campaign', async () => {
      await connect(db);
      await db.query(`insert into public.campaigns (org_id, id, internal_name, manager_id, parent_campaign_id) values ($1, '1004', 'Gold', 'm1', '1001')`, [OIZER]);
      const r = await ingest(db, 'charge', charge({
        paymentNumber: '1239', donorInfo: { donorNumber: null, newDonor: { DonorID: 'DNR1009', FirstName: 'Yossi', LastName: 'Klein' } },
        campaignInfo: { campaignNumber: 1001 }, reasonInfo: [{ reasonNumber: 1004, reasonName: 'Gold' }], paymentMethod: 'Donors_Fund',
      }));
      const d = (await db.query(`select campaign_id, donor_id, payment_method from public.donations where id = $1`, [r.donation_id])).rows[0];
      expect(d).toEqual({ campaign_id: '1004', donor_id: 'DNR1009', payment_method: 'Donors Fund' });
      expect((await db.query(`select first_name, last_name from public.donors where id = 'DNR1009'`)).rows[0]).toEqual({ first_name: 'Yossi', last_name: 'Klein' });
    });

    it('keep what can’t be matched, and run it again once fixed', async () => {
      await connect(db);
      const r = await ingest(db, 'charge', charge({ paymentNumber: '2000', campaignInfo: [{ campaignNumber: 1099 }] }));
      expect(r).toMatchObject({ status: 'unmatched', detail: 'no campaign 1099 here' });
      expect((await ingest(db, 'charge', charge({ paymentNumber: '2001', currency: 'ILS' }))).detail).toBe('paid in ILS, not dollars');
      await db.query(`insert into public.campaigns (org_id, id, internal_name, manager_id) values ($1, '1099', 'Late', 'm1')`, [OIZER]);
      const again = (await admin(db, `select public.donary_retry_event($1) r`, [r.event_id]))[0].r;
      expect(again.status).toBe('recorded');
      await expect(admin(db, `select public.donary_retry_event($1)`, [r.event_id])).rejects.toThrow(/Only unmatched/);
      await expect(rows(db, MANAGER_1, `select public.donary_retry_event($1)`, [r.event_id])).rejects.toThrow(/Only admins/);
    });

    it('void a donation, and ignore other status updates', async () => {
      await connect(db);
      const r = await ingest(db, 'charge', charge());
      expect((await ingest(db, 'void', { orgGuid: GUID, statusDateTime: '2026-11-09 00:00:00', paymentNumber: '1238', paymentStatus: 'Declined' })).status).toBe('ignored');
      expect((await ingest(db, 'void', { orgGuid: GUID, statusDateTime: '2026-11-09 00:00:00', paymentNumber: '1238', paymentStatus: 'Voided' })).status).toBe('recorded');
      expect((await db.query(`select status, reversal_reason, reversal_date::text from public.donations where id = $1`, [r.donation_id])).rows[0])
        .toEqual({ status: 'voided', reversal_reason: 'Voided at Donary', reversal_date: '2026-11-09' });
      expect((await ingest(db, 'void', { paymentNumber: '9999', paymentStatus: 'Voided' })).status).toBe('unmatched');
    });

    it('record a pledge once, and a schedule’s first payment', async () => {
      await connect(db);
      const pledge = { orgGuid: GUID, pledgeAmount: 100, currency: 'USD', pledgeNumber: 123456, donorInfo: { donorNumber: 'd2', newDonor: null },
        campaignInfo: { campaignNumber: 1002, campaignName: 'Second' }, reasonInfo: {}, collectorInfo: {}, locationInfo: {}, deviceCreatedDate: '2026-11-08T21:01:09.827' };
      const p = await ingest(db, 'pledge', pledge);
      expect((await db.query(`select campaign_id, donor_id, amount::text, donary_id, date_pledged::text from public.pledges where id = $1`, [p.pledge_id])).rows[0])
        .toEqual({ campaign_id: '1002', donor_id: 'd2', amount: '100.00', donary_id: '123456', date_pledged: '2026-11-08' });
      expect((await ingest(db, 'pledge', pledge)).status).toBe('duplicate');

      const schedule = { orgGuid: GUID, scheduleUniqueID: 'dc4f72b9-906b-4b6c-9e4d-d9f68787d907', totalScheduleAmount: 100, countOfSchedules: 10,
        frequency: 'Monthly', scheduleStartDate: '2026-11-08 00:00:00', currency: 'USD', donorInfo: { donorNumber: 'd1' },
        campaignInfo: [{ campaignNumber: 1001 }], reasonInfo: [], collectorInfo: {}, locationInfo: {},
        firstPayment: { processedDateTime: '2026-11-08 15:00:00', amount: 10, gatewayName: 'Matbia', paymentNumber: '112233', paymentMethod: 'Matbia', deviceName: 'Testing' } };
      const s = await ingest(db, 'schedule', schedule);
      expect(s).toMatchObject({ status: 'recorded', detail: '10 × Monthly 100; first payment recorded' });
      expect((await db.query(`select campaign_id, donor_id, amount::text, payment_method from public.donations where id = $1`, [s.donation_id])).rows[0])
        .toEqual({ campaign_id: '1001', donor_id: 'd1', amount: '10.00', payment_method: 'Matbia' });
      const later = await ingest(db, 'schedule', { ...schedule, scheduleUniqueID: 'later', firstPayment: undefined, scheduleStartDate: '2026-12-01 00:00:00' });
      expect(later).toMatchObject({ status: 'recorded', detail: '10 × Monthly from 2026-12-01 00:00:00, 100 in all' });
      expect(later.donation_id).toBeUndefined();
    });
  });
});
