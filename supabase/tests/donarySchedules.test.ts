import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, MANAGER_1, MANAGER_2, OIZER, rows, seededDb } from './harness';

// AppSheet gap review #6 (2026-11-19): Donary schedules are kept (read-only; Donary charges them), their first payment
// is linked, and a later payment is linked when it names its schedule. Both the direct webhook and the Make feed.
const GUID = '115e9d3d-baf2-4089-b896-9b2621ffcf1b';
const svc = async <T = Record<string, any>>(db: PGlite, q: string, params: unknown[] = []) => (await rows<T>(db, 'service_role', q, params))[0];
const token = async (db: PGlite) => (await db.query<{ t: string }>(`select webhook_token t from public.donary_settings`)).rows[0].t;
const webhook = async (db: PGlite, event: string, payload: unknown) =>
  (await svc<{ r: any }>(db, `select public.donary_ingest($1, $2, $3) r`, [await token(db), event, JSON.stringify(payload)])).r;
const list = (db: PGlite, who = ADMIN) => rows<Record<string, any>>(db, who,
  `select *, start_date::text as start_date, next_expected::text as next_expected from public.donary_schedule_list order by schedule_uid`, [], OIZER);

const schedule = (uid: string, over: Record<string, unknown> = {}) => ({
  orgGuid: GUID, scheduleUniqueID: uid, totalScheduleAmount: 100, countOfSchedules: 10, frequency: 'Monthly',
  scheduleStartDate: '2026-11-08 00:00:00', currency: 'USD', donorInfo: { donorNumber: 'd1' }, campaignInfo: [{ campaignNumber: 1001 }],
  reasonInfo: [], collectorInfo: {}, locationInfo: {},
  firstPayment: { processedDateTime: '2026-11-08 15:00:00', amount: 10, gatewayName: 'Matbia', paymentNumber: `${uid}-1`, paymentMethod: 'Matbia', deviceName: 'Testing' },
  ...over,
});
const charge = (num: string, over: Record<string, unknown> = {}) => ({
  orgGuid: GUID, donorInfo: { donorNumber: 'd1', newDonor: null }, campaignInfo: [{ campaignNumber: 1001 }], reasonInfo: [], collectorInfo: {},
  locationInfo: {}, processedDateTime: '2026-12-08T15:00:00', amount: 10, paymentNumber: num, gatewayRefNum: `ref-${num}`,
  paymentMethod: 'Matbia', currency: 'USD', deviceName: 'Testing', paymentStatus: 'Success', isAnonymousDonation: false, ...over,
});

describe('Donary schedules', () => {
  let base: PGlite;
  let db: PGlite;
  beforeAll(async () => {
    base = await seededDb();
    await base.exec(`update public.org_members set role = 'super_admin' where user_id = '${ADMIN}';`);
    await rows(base, ADMIN, `select public.save_donary_settings(true, $1, $2)`, [GUID, 'donary-test-key-0001']);
  });
  beforeEach(async () => { db = await base.clone(); });

  it('keeps a schedule from the webhook, links its first payment, and expects the next one a month on', async () => {
    const r = await webhook(db, 'schedule', schedule('S-1'));
    expect(r.status).toBe('recorded');
    expect(r.schedule_id).toBeTruthy();
    const [s] = await list(db);
    expect(s).toMatchObject({ schedule_uid: 'S-1', campaign_id: '1001', donor_id: 'd1', amount: '10.00', total_amount: '100.00', payments_total: 10,
      frequency: 'Monthly', status: 'active', came_from: 'Donary', payments_seen: 1, payments_left: 9, next_expected: '2026-12-08' });
    expect((await db.query(`select donary_schedule_id from public.donations where id = $1`, [r.donation_id])).rows[0]).toEqual({ donary_schedule_id: r.schedule_id });
    // Sent again: still one schedule.
    await webhook(db, 'schedule', { ...schedule('S-1'), countOfSchedules: 12 });
    expect((await list(db)).length).toBe(1);
  });

  it('links a later payment that names its schedule, and never guesses for one that does not', async () => {
    await webhook(db, 'schedule', schedule('S-2'));
    const named = await webhook(db, 'charge', charge('S-2-2', { scheduleUniqueID: 'S-2' }));
    const plain = await webhook(db, 'charge', charge('X-9'));             // same donor, amount and campaign, no schedule named
    const link = async (id: string) => (await db.query<{ s: string | null }>(`select donary_schedule_id s from public.donations where id = $1`, [id])).rows[0].s;
    expect(await link(named.donation_id)).toBeTruthy();
    expect(await link(plain.donation_id)).toBeNull();
    const [s] = await list(db);
    expect(s).toMatchObject({ payments_seen: 2, paid: '20.00', payments_left: 8, next_expected: '2027-01-08' });
  });

  it('keeps the collector Donary names on a gift that comes in directly (as the Make feed does)', async () => {
    const r = await webhook(db, 'charge', charge('C-1', { collectorInfo: { collectorNumber: 7, collectorName: 'Sample Collector' } }));
    const plain = await webhook(db, 'charge', charge('C-2'));
    const c = async (id: string) => (await db.query<{ c: string | null }>(`select collector_label c from public.donations where id = $1`, [id])).rows[0].c;
    expect(await c(r.donation_id)).toBe('Sample Collector');
    expect(await c(plain.donation_id)).toBeNull();
  });

  it('keeps a schedule that starts later, with nothing paid yet', async () => {
    await webhook(db, 'schedule', schedule('S-3', { firstPayment: undefined, scheduleStartDate: '2026-12-01 00:00:00', frequency: 'Weekly' }));
    const [s] = await list(db);
    expect(s).toMatchObject({ payments_seen: 0, amount: '10.00', next_expected: '2026-12-01' });
  });

  it('shows a fundraiser only schedules on their own campaigns', async () => {
    await webhook(db, 'schedule', schedule('S-4'));                                   // campaign 1001
    await webhook(db, 'schedule', schedule('S-5', { campaignInfo: [{ campaignNumber: 1002 }] }));
    const m1 = (await list(db, MANAGER_1)).map(s => s.schedule_uid);
    const m2 = (await list(db, MANAGER_2)).map(s => s.schedule_uid);
    expect(m1).toContain('S-4');
    expect(m1).not.toContain('S-5');
    expect(m2).not.toContain('S-4');
    await expect(rows(db, ADMIN, `insert into public.donary_schedules (org_id, schedule_uid) values ($1, 'hand-made')`, [OIZER], OIZER)).rejects.toThrow();
  });

  it('keeps schedules from the Make feed as test data that the test wipe removes', async () => {
    await db.query(`update public.org_members set role = 'super_admin' where user_id = $1`, [ADMIN]);
    const [{ k }] = await rows<{ k: string }>(db, ADMIN, `select public.make_ingest_new_secret() k`);
    await rows(db, ADMIN, `select public.make_ingest_set_enabled(true)`);
    const make = async (source: string, body: unknown) =>
      (await db.query<{ r: any }>(`select public.make_ingest($1, $2, $3, $4::jsonb) r`, [OIZER, k, source, JSON.stringify(body)])).rows[0].r;
    const r = await make('donary-schedule', { scheduleUniqueID: 'M-1', totalScheduleAmount: 60, countOfSchedules: 6, frequency: 'Monthly',
      scheduleStartDate: '2026-11-10', campaignInfo: [{ campaignNumber: '1002' }], donorInfo: { firstName: 'Sample', lastName: 'Donor' },
      firstPayment: { amount: 10, deviceName: 'Web', paymentMethod: 'Credit Card', gatewayRefNum: 'G-M1', paymentNumber: 'P-M1' } });
    expect(r.schedule_id).toBeTruthy();
    const later = await make('donary-payment', { amount: 10, scheduleUniqueID: 'M-1', paymentNumber: 'P-M2', gatewayRefNum: 'G-M2',
      campaignInfo: [{ campaignNumber: '1002' }], donorInfo: { firstName: 'Sample', lastName: 'Donor' }, deviceName: 'Web', paymentMethod: 'Credit Card' });
    const [s] = (await list(db)).filter(x => x.schedule_uid === 'M-1');
    expect(s).toMatchObject({ came_from: 'Make', name: 'Sample Donor', payments_seen: 2, payments_total: 6, next_expected: '2027-01-10' });
    expect(later.record_id).toBeTruthy();
    const [{ batch_id }] = (await db.query<{ batch_id: string }>(`select batch_id from public.make_ingest_settings where org_id = $1`, [OIZER])).rows;
    await db.query(`select public.delete_test_import($1)`, [batch_id]);   // run by the owner, as in makeIngest.test.ts
    expect((await db.query(`select 1 from public.donary_schedules where schedule_uid = 'M-1'`)).rows).toEqual([]);
  });
});
