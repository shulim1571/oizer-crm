import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, MANAGER_1, OIZER, as, rows, seededDb } from './harness';

const OTHER = '00000000-0000-4000-8000-0000000000cc';
const OTHER_ADMIN = '00000000-0000-0000-0000-0000000000c1';

const one = async <T = Record<string, any>>(db: PGlite, q: string, params: unknown[] = [], user: string = ADMIN, org?: string) =>
  (await rows<T>(db, user, q, params, org))[0];
const svc = async <T = Record<string, any>>(db: PGlite, q: string, params: unknown[] = []) => (await rows<T>(db, 'service_role', q, params))[0];
const newKey = async (db: PGlite, scopes: string[], user = ADMIN, org?: string) =>
  (await one<{ k: string }>(db, `select public.create_api_key('Test system', $1) k`, [scopes], user, org)).k;
const call = async (db: PGlite, key: string, resource: string, params: Record<string, unknown> = {}) =>
  (await svc<{ r: any }>(db, `select public.api_request($1, $2, $3) r`, [key, resource, JSON.stringify(params)])).r;
const sqlstate = async (p: Promise<unknown>) => { try { await p; return null; } catch (e: any) { return e.code as string; } };

describe('platform operations', () => {
  let base: PGlite;
  let db: PGlite;
  beforeAll(async () => {
    base = await seededDb();
    await base.exec(`
      update public.org_members set role = 'super_admin' where user_id = '${ADMIN}';
      insert into public.organizations (id, slug, name) values ('${OTHER}', 'other', 'Other Org');
      insert into auth.users (id, email) values ('${OTHER_ADMIN}', 'admin@other.org');
      insert into public.org_members (org_id, user_id, role) values ('${OTHER}', '${OTHER_ADMIN}', 'super_admin');
      insert into public.donors (org_id, id, first_name, last_name) values ('${OTHER}', 'x1', 'Their', 'Donor');
    `);
  });
  beforeEach(async () => { db = await base.clone(); });

  describe('API keys', () => {
    it('show the key once and keep only its hash', async () => {
      const key = await newKey(db, ['donors', 'campaigns', 'donors']);
      expect(key).toMatch(/^oz_live_[0-9a-f]{8}_[0-9a-f]{48}$/);
      const listed = await rows(db, ADMIN, `select * from public.list_api_keys()`);
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ name: 'Test system', prefix: key.slice(8, 16), scopes: ['campaigns', 'donors'] });
      expect(JSON.stringify(listed)).not.toContain(key.slice(17));
      const raw = await db.query<{ h: string }>(`select encode(key_hash, 'hex') h from public.api_keys`);
      expect(raw.rows[0].h).not.toContain(key.slice(17));
      await expect(rows(db, ADMIN, `select * from public.api_keys`)).rejects.toThrow();
      const log = await db.query<{ action: string }>(`select action from public.activity_log where action like 'api_key%'`);
      expect(log.rows.map(r => r.action)).toEqual(['api_key_created']);
    });

    it('let only the Super Admin create and revoke keys', async () => {
      await db.query(`update public.org_members set role = 'admin' where user_id = $1`, [ADMIN]);
      await expect(newKey(db, ['donors'])).rejects.toThrow(/Only the Super Admin/);
      await expect(rows(db, MANAGER_1, `select * from public.list_api_keys()`)).resolves.toEqual([]);
      await expect(rows(db, 'anon', `select public.create_api_key('x', '{donors}')`)).rejects.toThrow();
      await db.query(`update public.org_members set role = 'super_admin' where user_id = $1`, [ADMIN]);
      await expect(newKey(db, [])).rejects.toThrow(/Choose what the key may read/);
      await expect(newKey(db, ['expenses'])).rejects.toThrow(/campaigns, donors and donations/);
    });

    it('answer only with the key’s own organization and scopes', async () => {
      const key = await newKey(db, ['donors']);
      const theirs = await newKey(db, ['donors'], OTHER_ADMIN, OTHER);
      expect((await call(db, key, 'donors')).data.map((d: any) => d.id)).toEqual(['d1', 'd2']);
      expect((await call(db, theirs, 'donors')).data.map((d: any) => d.id)).toEqual(['x1']);
      expect(await sqlstate(call(db, key, 'donations'))).toBe('PT403');
      expect(await sqlstate(call(db, key, 'expenses'))).toBe('PT404');
      expect(await sqlstate(call(db, key, 'donors', { id: 'x1' }))).toBe('PT404');
      expect((await call(db, key, 'donors', { id: 'd2' })).data).toMatchObject({ id: 'd2', last_name: 'Two' });
    });

    it('turn away wrong, revoked and suspended keys, and nobody else may call it', async () => {
      const key = await newKey(db, ['campaigns']);
      expect(await sqlstate(call(db, 'nope', 'campaigns'))).toBe('PT401');
      expect(await sqlstate(call(db, key.slice(0, -1) + (key.endsWith('0') ? '1' : '0'), 'campaigns'))).toBe('PT401');
      await db.query(`update public.organizations set status = 'suspended' where id = $1`, [OIZER]);
      expect(await sqlstate(call(db, key, 'campaigns'))).toBe('PT401');
      await db.query(`update public.organizations set status = 'active' where id = $1`, [OIZER]);
      const { id } = await one<{ id: string }>(db, `select id from public.list_api_keys()`);
      await as(db, ADMIN, tx => tx.query(`select public.revoke_api_key($1)`, [id]));
      expect(await sqlstate(call(db, key, 'campaigns'))).toBe('PT401');
      await expect(rows(db, ADMIN, `select public.api_request($1, 'campaigns', '{}')`, [key])).rejects.toThrow();
      await expect(rows(db, 'anon', `select public.api_request($1, 'campaigns', '{}')`, [key])).rejects.toThrow();
    });

    it('page through results and filter donations', async () => {
      const key = await newKey(db, ['donations', 'campaigns']);
      const first = await call(db, key, 'donations', { limit: 2 });
      expect(first.data.map((d: any) => d.id)).toEqual(['b1', 'c1']);
      expect(first.next).toBe('c1');
      const second = await call(db, key, 'donations', { limit: 2, after: first.next });
      expect(second.data.map((d: any) => d.id)).toEqual(['p1', 'p2']);
      const all = await call(db, key, 'donations', { limit: 100 });
      expect(all.next).toBeNull();
      expect((await call(db, key, 'donations', { campaign_id: '1003' })).data.map((d: any) => d.id)).toEqual(['p3']);
      expect(Object.keys(all.data[0])).not.toContain('custom_fields');
      expect(await sqlstate(call(db, key, 'campaigns', { limit: 500 }))).toBe('PT422');
      expect(await sqlstate(call(db, key, 'campaigns', { updated_since: 'yesterday-ish' }))).toBe('PT422');
      expect((await call(db, key, 'campaigns', { updated_since: '2999-01-01T00:00:00Z' })).data).toEqual([]);
    });

    it('allow 60 requests a minute per key', async () => {
      const key = await newKey(db, ['campaigns']);
      const other = await newKey(db, ['campaigns']);
      let last: any;
      for (let i = 0; i < 60; i++) last = await call(db, key, 'campaigns', { limit: 1 });
      expect(last.rate).toMatchObject({ limit: 60, remaining: 0 });
      expect(await sqlstate(call(db, key, 'campaigns'))).toBe('PT429');
      expect((await call(db, other, 'campaigns', { limit: 1 })).rate.remaining).toBe(59);
      // A new minute starts the count again.
      await db.query(`update public.api_rate set window_start = window_start - interval '1 minute'`);
      expect((await call(db, key, 'campaigns', { limit: 1 })).rate.remaining).toBe(59);
      expect((await one(db, `select last_used_at from public.list_api_keys() where prefix = $1`, [key.slice(8, 16)])).last_used_at).not.toBeNull();
    });
  });

  describe('web addresses', () => {
    it('tidy and check hostnames', async () => {
      const clean = async (h: string) => (await db.query<{ h: string | null }>(`select public.clean_hostname($1) h`, [h])).rows[0].h;
      expect(await clean(' https://Donate.Example.org/give?x=1 ')).toBe('donate.example.org');
      expect(await clean('donate.example.org.')).toBe('donate.example.org');
      expect(await clean('donate.example.org:443')).toBe('donate.example.org');
      expect(await clean('not a host')).toBeNull();
      expect(await clean('-bad.example.org')).toBeNull();
      expect(await clean('localhost')).toBeNull();
    });

    it('set up the default subdomain and the organization’s own addresses', async () => {
      // oizer.trubase.org already leads here, so the default subdomain is taken.
      await expect(rows(db, ADMIN, `select * from public.request_web_address('subdomain')`)).rejects.toThrow(/already set up/);
      const sub = await one(db, `select * from public.request_web_address('subdomain')`, [], OTHER_ADMIN, OTHER);
      expect(sub).toMatchObject({ hostname: 'other.trubase.org', kind: 'subdomain' });
      const mine = await one(db, `select * from public.request_web_address('custom', 'https://Donate.Oizer.org/')`);
      expect(mine.hostname).toBe('donate.oizer.org');
      await expect(rows(db, OTHER_ADMIN, `select * from public.request_web_address('custom', 'donate.oizer.org')`, [], OTHER)).rejects.toThrow(/already set up/);
      await expect(rows(db, ADMIN, `select * from public.request_web_address('custom', 'evil.trubase.org')`)).rejects.toThrow(/set up by the platform/);
      await expect(rows(db, ADMIN, `select * from public.request_web_address('custom', 'oizer.org')`)).rejects.toThrow(/bare domain/);
      await expect(rows(db, ADMIN, `select * from public.request_web_address('custom', 'nope')`)).rejects.toThrow(/such as donate/);
      for (let i = 2; i <= 5; i++) await rows(db, ADMIN, `select * from public.request_web_address('custom', $1)`, [`d${i}.oizer.org`]);
      await expect(rows(db, ADMIN, `select * from public.request_web_address('custom', 'd6.oizer.org')`)).rejects.toThrow(/up to 5/);
      const list = await rows(db, ADMIN, `select hostname, status, leads_here from public.web_addresses()`);
      expect(list.find(r => r.hostname === 'oizer.trubase.org')).toMatchObject({ status: 'active', leads_here: true });
      expect(list.find(r => r.hostname === 'donate.oizer.org')).toMatchObject({ status: 'requested', leads_here: false });
      expect(list.some(r => r.hostname === 'other.trubase.org')).toBe(false);
    });

    it('lead to the organization only once the address and certificate are active, and stop when removed', async () => {
      const { id } = await one(db, `select * from public.request_web_address('custom', 'give.oizer.org')`);
      const resolve = async () => (await rows(db, 'anon', `select id from public.resolve_org('give.oizer.org', null)`)).map(r => r.id);
      const records = JSON.stringify([{ type: 'CNAME', name: 'give.oizer.org', value: 'oizer-drm.pages.dev', purpose: 'route' }]);
      await svc(db, `select public.record_web_address($1, 'pages', 'give.oizer.org', 'pending', 'pending', $2, null)`, [id, records]);
      expect(await resolve()).toEqual([]);
      expect((await one(db, `select dns_records from public.web_addresses() where id = $1`, [id])).dns_records[0].value).toBe('oizer-drm.pages.dev');
      await svc(db, `select public.record_web_address($1, null, null, 'active', 'pending', null, null)`, [id]);
      expect(await resolve()).toEqual([]);
      expect((await rows(db, 'service_role', `select hostname from public.web_addresses_to_check()`)).map(r => r.hostname)).toEqual(['give.oizer.org']);
      await svc(db, `select public.record_web_address($1, null, null, 'active', 'active', null, null)`, [id]);
      expect(await resolve()).toEqual([OIZER]);
      expect(await rows(db, 'service_role', `select hostname from public.web_addresses_to_check()`)).toEqual([]);

      await db.query(`update public.org_members set role = 'admin' where user_id = $1`, [ADMIN]);
      await expect(rows(db, ADMIN, `select * from public.remove_web_address($1)`, [id])).rejects.toThrow(/Only the Super Admin/);
      await db.query(`update public.org_members set role = 'super_admin' where user_id = $1`, [ADMIN]);
      await expect(rows(db, OTHER_ADMIN, `select * from public.remove_web_address($1)`, [id], OTHER)).rejects.toThrow(/isn't part of this organization/);
      expect(await one(db, `select provider, provider_id from public.remove_web_address($1)`, [id])).toEqual({ provider: 'pages', provider_id: 'give.oizer.org' });
      expect(await resolve()).toEqual([]);
      await svc(db, `select public.forget_web_address($1)`, [id]);
      expect(await db.query(`select 1 from public.org_web_addresses where id = $1`, [id]).then(r => r.rows)).toEqual([]);
      await expect(rows(db, ADMIN, `select public.record_web_address($1, null, null, 'active', 'active', null, null)`, [id])).rejects.toThrow();
    });
  });

  describe('"Powered by" footer', () => {
    it('is off until the Super Admin turns it on, and then public', async () => {
      const footer = async () => rows(db, 'anon', `select * from public.org_footer($1)`, [OIZER]);
      expect(await footer()).toEqual([]);
      await rows(db, ADMIN, `select public.save_org_footer(false, 'Powered by Oizer', 'https://example.org')`);
      expect(await footer()).toEqual([]);
      expect(await rows(db, ADMIN, `select * from public.org_footer($1)`, [OIZER])).toEqual([{ enabled: false, text: 'Powered by Oizer', url: 'https://example.org' }]);
      await rows(db, ADMIN, `select public.save_org_footer(true, '  Powered by Oizer ', '')`);
      expect(await footer()).toEqual([{ enabled: true, text: 'Powered by Oizer', url: null }]);
      await expect(rows(db, ADMIN, `select public.save_org_footer(true, '', null)`)).rejects.toThrow(/footer's words/);
      await expect(rows(db, ADMIN, `select public.save_org_footer(true, 'x', 'javascript:alert(1)')`)).rejects.toThrow(/https/);
      await expect(rows(db, ADMIN, `select public.save_org_footer(true, $1, null)`, ['x'.repeat(81)])).rejects.toThrow(/80 characters/);
      await expect(rows(db, MANAGER_1, `select public.save_org_footer(false, null, null)`)).rejects.toThrow(/Only the Super Admin/);
      await db.query(`update public.organizations set status = 'suspended' where id = $1`, [OIZER]);
      expect(await footer()).toEqual([]);
    });
  });
});
