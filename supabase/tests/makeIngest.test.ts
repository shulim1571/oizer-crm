import { describe, expect, it } from 'vitest';
import { ADMIN, MANAGER_1, OIZER, as, rows, seededDb } from './harness';

// Shulim, 2026-11-12: Make sends Oizer's live Donary, Sola and Elevon transactions to Donor Base for testing.
async function setup() {
  const db = await seededDb();
  await db.query(`update public.org_members set role = 'super_admin' where user_id = $1`, [ADMIN]);
  const [{ k }] = await rows<{ k: string }>(db, ADMIN, `select public.make_ingest_new_secret() k`);
  await rows(db, ADMIN, `select public.make_ingest_set_enabled(true)`);
  const ingest = async (source: string, body: unknown, key = k) =>
    (await db.query<{ r: any }>(`select public.make_ingest($1, $2, $3, $4::jsonb) r`, [OIZER, key, source, JSON.stringify(body)])).rows[0].r;
  return { db, k, ingest };
}

const donaryPayment = {
  donorInfo: { firstName: 'Test', lastName: 'Donor', donorPhones: [{ phoneNumber: '5550001111' }] },
  campaignInfo: [{ campaignNumber: '1001' }], reasonInfo: [{ reasonName: 'General' }], collectorInfo: { collectorName: 'C1' },
  processedDateTime: '2026-11-12T10:00:00Z', amount: '18.00', token: 'tok_secret', maskedAPIKey: 'xx', paymentNumber: 'P-100',
  gatewayRefNum: 'G-100', paymentMethod: 'Credit Card', deviceName: 'Oizer #1', paymentStatus: 'Approved', isAnonymousDonation: false,
};

describe('make ingest', () => {
  it('records a Donary payment once, tagged for the test batch, keeping no token, no body and no history', async () => {
    const { db, ingest } = await setup();
    const r1 = await ingest('donary-payment', donaryPayment);
    expect(r1).toMatchObject({ ok: true, status: 201, outcome: 'created' });
    const r2 = await ingest('donary-payment', { ...donaryPayment, gatewayRefNum: 'other' });   // a retry
    expect(r2).toMatchObject({ ok: true, outcome: 'duplicate', record_id: r1.record_id });
    const [d] = (await db.query<any>(`select * from public.donations where id = $1`, [r1.record_id])).rows;
    expect(d).toMatchObject({ campaign_id: '1001', amount: '18.00', status: 'completed', donary_id: 'P-100', gateway_id: 'G-100', name: 'Test Donor', phone: '5550001111', command: 'Donary Payment' });
    const everything = JSON.stringify((await db.query(`select * from public.donations where id = $1`, [r1.record_id])).rows)
      + JSON.stringify((await db.query(`select * from public.make_ingest_log`)).rows);
    expect(everything).not.toContain('tok_secret');
    expect((await db.query(`select 1 from public.activity_log where record_id = $1`, [r1.record_id])).rows).toEqual([]);
    expect((await db.query(`select table_name from public.test_import_rows where record_id = $1`, [r1.record_id])).rows).toEqual([{ table_name: 'donations' }]);
  });

  it('voids by payment number, records schedules and pledges, and handles Sola and Elevon', async () => {
    const { db, ingest } = await setup();
    const pay = await ingest('donary-payment', donaryPayment);
    expect(await ingest('donary-void', { orgGUID: 'x', paymentNumber: 'P-100', paymentStatus: 'Voided' })).toMatchObject({ outcome: 'voided', record_id: pay.record_id });
    expect((await db.query(`select status from public.donations where id = $1`, [pay.record_id])).rows).toEqual([{ status: 'voided' }]);
    expect(await ingest('donary-void', { paymentNumber: 'nope' })).toMatchObject({ ok: true, outcome: 'skipped' });

    const sch = await ingest('donary-schedule', { campaignInfo: [{ campaignNumber: '1002' }], donorInfo: { firstName: 'S' }, firstPayment: { amount: 25, deviceName: 'Web', paymentMethod: 'Credit Card', gatewayRefNum: 'G-200', paymentNumber: 'P-200' } });
    expect(sch).toMatchObject({ outcome: 'created' });
    const pl = await ingest('donary-pledge', { pledgeAmount: '360', pledgeNumber: 'PL-1', campaignInfo: [{ campaignNumber: '1001' }], donorInfo: { firstName: 'P' } });
    expect(pl).toMatchObject({ outcome: 'created' });
    expect(await ingest('donary-pledge', { pledgeAmount: '360', pledgeNumber: 'PL-1' })).toMatchObject({ outcome: 'duplicate', record_id: pl.record_id });
    expect((await db.query(`select source, donary_id, amount from public.pledges where id = $1`, [pl.record_id])).rows).toEqual([{ source: 'Donary', donary_id: 'PL-1', amount: '360.00' }]);

    const sola = { xCustom02: '1001', xBillFirstName: 'A', xBillLastName: 'B', xAmount: '10', xCommand: 'cc:sale', xResponseResult: 'Approved', xRefNum: 'R-1', xToken: 'tok2', xKey: 'key2' };
    const s1 = await ingest('sola', sola);
    expect(s1).toMatchObject({ outcome: 'created' });
    expect(await ingest('sola', sola)).toMatchObject({ outcome: 'duplicate' });
    expect(await ingest('sola', { xCommand: 'cc:void', xRefNum: 'R-1' })).toMatchObject({ outcome: 'voided', record_id: s1.record_id });

    const el = { external_campaign_id: '1003', name: 'E', amount: 7, payment_method: 'Credit Card', payment_status: 'succeeded', payment_info: { referenceId: 'E-1', card_number: '4111' } };
    const e1 = await ingest('elevon', el);
    expect(e1).toMatchObject({ outcome: 'created' });
    expect((await db.query<any>(`select d.command, s.name source, d.gateway_id from public.donations d left join public.sources s on s.org_id = d.org_id and s.id = d.source where d.id = $1`, [e1.record_id])).rows)
      .toEqual([{ command: 'Sale', source: 'Cartis', gateway_id: 'E-1' }]);
    expect(await ingest('elevon', el)).toMatchObject({ outcome: 'duplicate' });

    expect(JSON.stringify((await db.query(`select * from public.donations where id like 'MK-%'`)).rows)).not.toMatch(/tok2|key2/);
  });

  it('refuses a wrong key, a switched-off organization and an unknown source; a bad body is logged without its contents', async () => {
    const { db, ingest } = await setup();
    expect(await ingest('sola', { xAmount: 1 }, 'dbk_wrong')).toMatchObject({ ok: false, status: 401 });
    expect(await ingest('paypal', {})).toMatchObject({ ok: false, status: 400 });
    expect(await ingest('elevon', { name: 'Private Person', payment_status: 'succeeded' })).toMatchObject({ ok: false, status: 422 });
    expect(JSON.stringify((await db.query(`select * from public.make_ingest_log`)).rows)).not.toContain('Private Person');
    await rows(db, ADMIN, `select public.make_ingest_set_enabled(false)`);
    expect(await ingest('sola', { xAmount: 1 })).toMatchObject({ ok: false, status: 403 });
  });

  it('only the Super Admin manages the secret; others see nothing; the key is never stored', async () => {
    const { db, k } = await setup();
    expect(k).toMatch(/^dbk_[0-9a-f]{48}$/);
    expect(JSON.stringify((await db.query(`select * from public.make_ingest_settings`)).rows)).not.toContain(k);
    await db.query(`update public.org_members set role = 'admin' where user_id = $1`, [ADMIN]);
    await expect(rows(db, ADMIN, `select public.make_ingest_new_secret()`)).rejects.toThrow(/Super Admin/);
    expect((await rows<any>(db, ADMIN, `select * from public.make_ingest_status()`))[0]).toMatchObject({ enabled: true, secret_set: true });
    expect(await rows(db, MANAGER_1, `select * from public.make_ingest_status()`)).toEqual([]);
    await expect(as(db, ADMIN, tx => tx.query(`select public.make_ingest('${OIZER}', 'x', 'sola', '{}')`))).rejects.toThrow();
    await expect(rows(db, ADMIN, `select * from public.make_ingest_log`)).rejects.toThrow();
  });

  it('the whole Make batch is removed in one call, leaving sample data and existing sources alone', async () => {
    const { db, ingest } = await setup();
    const before = (await db.query<{ n: number }>(`select count(*)::int n from public.donations where id not like 'MK-%'`)).rows[0].n;
    const sources = (await db.query<{ n: number }>(`select count(*)::int n from public.sources`)).rows[0].n;
    await ingest('donary-payment', donaryPayment);
    await ingest('elevon', { amount: 5, payment_status: 'succeeded', payment_info: { referenceId: 'E-9' } });
    await ingest('donary-pledge', { pledgeAmount: 100, pledgeNumber: 'PL-9' });
    const [{ b }] = (await db.query<{ b: string }>(`select batch_id b from public.make_ingest_settings`)).rows;
    const [{ r }] = (await db.query<{ r: any }>(`select public.delete_test_import($1) r`, [b])).rows;
    expect(r).toMatchObject({ donations: 2, pledges: 1 });
    expect((await db.query(`select 1 from public.donations where id like 'MK-%' union all select 1 from public.pledges where id like 'MK-%'`)).rows).toEqual([]);
    expect((await db.query<{ n: number }>(`select count(*)::int n from public.donations`)).rows[0].n).toBe(before);
    expect((await db.query<{ n: number }>(`select count(*)::int n from public.sources`)).rows[0].n).toBe(sources);
  });
});
