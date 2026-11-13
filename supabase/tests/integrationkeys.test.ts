import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, MANAGER_1, OIZER, as, rows, seededDb } from './harness';

const sql = (db: PGlite, q: string, params: unknown[] = [], user = ADMIN) => as(db, user, tx => tx.query(q, params));
const one = async <T = Record<string, any>>(db: PGlite, q: string, params: unknown[] = [], user: string = ADMIN) => (await rows<T>(db, user, q, params))[0];
const svc = async (db: PGlite, q: string, params: unknown[] = []) => (await rows(db, 'service_role', q, params))[0];
const OTHER = '00000000-0000-4000-8000-0000000000ee';
const SG = 'SG.abcdefghij.klmnopqrstuvwxyz0123456789';
// Built rather than written out, so secret scanners don't take these made-up keys for real ones.
const SID = 'AC' + 'f'.repeat(32);
const TOKEN = 'e'.repeat(32);
const SITE = '0x4AAAAAAAsite_key';
const SECRET = '0x4AAAAAAAsecret_key';

describe('per-organization integration keys', () => {
  let base: PGlite;
  let db: PGlite;
  beforeAll(async () => {
    base = await seededDb();
    await base.query(`update public.org_members set role = 'super_admin' where user_id = $1`, [ADMIN]);
  });
  beforeEach(async () => { db = await base.clone(); });

  it('keep the secrets encrypted and show only whether each is set', async () => {
    await sql(db, `select public.save_email_keys($1, 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE')`, [SG]);
    await sql(db, `select public.save_sms_keys($1, $2)`, [SID, TOKEN]);
    await sql(db, `select public.save_turnstile_keys($1, $2)`, [SITE, SECRET]);
    expect(await one(db, `select sendgrid_key_set, sendgrid_webhook_key_set, twilio_sid, twilio_token_set, turnstile_site_key, turnstile_secret_set from public.integration_keys_status()`))
      .toEqual({ sendgrid_key_set: true, sendgrid_webhook_key_set: true, twilio_sid: 'AC…ffff', twilio_token_set: true, turnstile_site_key: SITE, turnstile_secret_set: true });
    const raw = (await db.query<{ k: string }>(`select encode(sendgrid_key, 'escape') || encode(twilio_token, 'escape') || encode(turnstile_secret, 'escape') k from public.integration_keys`)).rows[0];
    expect(raw.k).not.toContain(SG);
    expect(raw.k).not.toContain(TOKEN);
    expect(await svc(db, `select * from public.org_messaging_keys($1)`, [OIZER]))
      .toEqual({ sendgrid_key: SG, sendgrid_webhook_key: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE', twilio_sid: SID, twilio_token: TOKEN });
    expect((await svc(db, `select public.org_turnstile_secret($1) s`, [OIZER])).s).toBe(SECRET);
    await expect(rows(db, ADMIN, `select * from public.integration_keys`)).rejects.toThrow();
    await expect(rows(db, ADMIN, `select * from public.org_messaging_keys($1)`, [OIZER])).rejects.toThrow();
  });

  it('keep a key left empty, and check the shapes', async () => {
    await sql(db, `select public.save_sms_keys($1, $2)`, [SID, TOKEN]);
    await sql(db, `select public.save_sms_keys(null, '')`);
    expect((await svc(db, `select twilio_token from public.org_messaging_keys($1)`, [OIZER])).twilio_token).toBe(TOKEN);
    await expect(sql(db, `select public.save_email_keys('abc', null)`)).rejects.toThrow(/starts with SG/);
    await expect(sql(db, `select public.save_email_keys(null, null)`)).rejects.toThrow(/Enter the SendGrid API key/);
    await expect(sql(db, `select public.save_sms_keys('AC12', null)`)).rejects.toThrow(/starts with AC/);
    await expect(sql(db, `select public.save_turnstile_keys($1, null)`, [SITE])).rejects.toThrow(/both the site key and the secret/);
  });

  it('let only the Super Admin change keys, and go back to the platform keys', async () => {
    await db.query(`update public.org_members set role = 'admin' where user_id = $1`, [ADMIN]);
    await expect(sql(db, `select public.save_email_keys($1, null)`, [SG])).rejects.toThrow(/Only the Super Admin/);
    await expect(rows(db, MANAGER_1, `select * from public.integration_keys_status()`)).resolves.toEqual([]);
    await db.query(`update public.org_members set role = 'super_admin' where user_id = $1`, [ADMIN]);
    await sql(db, `select public.save_turnstile_keys($1, $2)`, [SITE, SECRET]);
    await sql(db, `select public.clear_integration_keys('turnstile')`);
    expect((await svc(db, `select public.org_turnstile_secret($1) s`, [OIZER])).s).toBeNull();
    const log = await db.query(`select action from public.activity_log where action like 'integration_keys%' order by id`);
    expect(log.rows.map((r: any) => r.action)).toEqual(['integration_keys_changed', 'integration_keys_cleared']);
  });

  it('put the organization\'s own Turnstile site key on its payment page', async () => {
    await sql(db, `select public.save_payment_settings('ifields_public', 'api_secret', null, true)`);
    const page = async () => (await svc(db, `select public.public_give_page($1, '1001') p`, [OIZER])).p;
    expect((await page()).payments.turnstile_site_key).toBeNull();
    await sql(db, `select public.save_turnstile_keys($1, $2)`, [SITE, SECRET]);
    expect((await page()).payments.turnstile_site_key).toBe(SITE);
  });

  it('let reports signed with one organization\'s keys touch only its messages', async () => {
    await db.query(`insert into public.organizations (id, slug, name) values ('${OTHER}', 'other', 'Other Org')`);
    const id = (await db.query<{ id: string }>(`insert into public.messages (org_id, channel, to_address, body, kind, status, provider_id)
      values ($1, 'email', 'd@example.org', 'hi', 'test', 'sent', 'pid1') returning id`, [OIZER])).rows[0].id;
    await svc(db, `select public.message_event_scoped($1, null, 'pid1', 'delivered', null, null)`, [OTHER]);
    expect((await db.query<{ status: string }>(`select status from public.messages where id = $1`, [id])).rows[0].status).toBe('sent');
    await svc(db, `select public.message_event_scoped($1, $2, 'pid1', 'delivered', null, null)`, [OTHER, id]);
    expect((await db.query<{ status: string }>(`select status from public.messages where id = $1`, [id])).rows[0].status).toBe('sent');
    await svc(db, `select public.message_event_scoped($1, null, 'pid1', 'delivered', null, null)`, [OIZER]);
    expect((await db.query<{ status: string }>(`select status from public.messages where id = $1`, [id])).rows[0].status).toBe('delivered');
  });
});
