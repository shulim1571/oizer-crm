import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite, type Transaction } from '@electric-sql/pglite';

const DIR = join(__dirname, '..', 'migrations');
const MULTI_TENANT = '20261102000000_multi_tenant.sql';

export const ADMIN = '00000000-0000-0000-0000-00000000000a';
export const MANAGER_1 = '00000000-0000-0000-0000-000000000001';
export const MANAGER_2 = '00000000-0000-0000-0000-000000000002';
export const PENDING = '00000000-0000-0000-0000-00000000000f';
export const OIZER = '00000000-0000-4000-8000-000000000001';

// The parts of a Supabase project our migrations rely on.
const SUPABASE_STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create role supabase_auth_admin nologin;
  create role authenticator nologin;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

  create schema auth;
  grant usage on schema auth to anon, authenticated, service_role;
  create table auth.users (
    id uuid primary key default gen_random_uuid(),
    email text,
    encrypted_password text,
    last_sign_in_at timestamptz,
    raw_user_meta_data jsonb default '{}'
  );
  create function auth.jwt() returns jsonb language sql stable as
    $$ select nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
  create function auth.uid() returns uuid language sql stable as
    $$ select (auth.jwt() ->> 'sub')::uuid $$;
  grant execute on all functions in schema auth to anon, authenticated, service_role;

  create schema cron;
  create table cron.job (jobname text primary key, schedule text, command text);
  create function cron.schedule(name text, schedule text, command text) returns bigint language sql as
    $$ insert into cron.job values (name, schedule, command) returning 1::bigint $$;
`;

export const migrationFiles = () => readdirSync(DIR).filter(f => f.endsWith('.sql')).sort();

/** Runs the named migrations, or all of them. Extensions aren't bundled here; pg_cron is stubbed above. */
export async function migrate(db: PGlite, files = migrationFiles()) {
  for (const f of files) {
    const sql = readFileSync(join(DIR, f), 'utf8').replace(/create extension if not exists \w+;/gi, '');
    await db.exec(sql);
  }
}

const SEED = `
  insert into public.admin_emails (email) values ('office@example.org');
  insert into public.managers (id, first_name, last_name, email) values
    ('m1', 'Manager', 'One', 'one@example.org'),
    ('m2', 'Manager', 'Two', 'two@example.org');
  insert into auth.users (id, email) values
    ('${ADMIN}', 'office@example.org'),
    ('${MANAGER_1}', 'one@example.org'),
    ('${MANAGER_2}', 'two@example.org'),
    ('${PENDING}', 'nobody@example.org');
  insert into public.donors (id, first_name, last_name) values ('d1', 'Donor', 'One'), ('d2', 'Donor', 'Two');
  insert into public.accounts (id, name) values ('a1', 'Operating');
  insert into public.sources (id, name) values ('s1', 'Oizer #1');
  insert into public.campaigns (id, real_name, manager_id, sub_manager_ids) values
    ('1001', 'First campaign', 'm1', '{}'),
    ('1002', 'Second campaign', 'm2', '{}'),
    ('1003', 'Shared campaign', 'm2', '{m1}');
  insert into public.donations (id, campaign_id, donor_id, type, amount, fee, funded, batch_pending) values
    ('p1', '1001', 'd1', 'Payment', 1000.00, 29.30, null, null),
    ('p2', '1001', 'd2', 'Payment',  250.50,  7.56, null, null),
    ('v1', '1001', 'd1', 'Voided',   999.00,  5.00, null, null),
    ('c1', '1001', 'd1', 'Collect',   40.00,  null, null, null),
    ('b1', '1002', 'd2', 'Batch',    500.00, 25.00, 300.00, 200.00),
    ('p3', '1003', 'd2', 'Payment',  100.00,  3.20, null, null);
  insert into public.expenses (id, campaign_id, amount, account_id) values ('e1', '1001', 300.25, 'a1');
  insert into public.transfers (id, amount, from_campaign_id, to_campaign_id) values ('t1', 75.00, '1001', '1002');
  insert into public.tasks (id, campaign_id, title) values ('k1', '1001', 'Call donor'), ('k2', '1002', 'Other task');
  insert into public.pledges (id, campaign_id, donor_id, amount) values ('g1', '1001', 'd1', 500.00);
`;

export async function seed(db: PGlite) {
  await db.exec(SEED);
}

export async function freshDb() {
  const db = new PGlite();
  await db.exec(SUPABASE_STUB);
  return db;
}

/**
 * The same path the live database takes: Oizer's data exists first, then the multi-tenant
 * migration turns it into the first organization.
 */
export async function seededDb() {
  const db = await freshDb();
  const files = migrationFiles();
  const split = files.indexOf(MULTI_TENANT);
  await migrate(db, files.slice(0, split));
  await seed(db);
  await migrate(db, files.slice(split));
  return db;
}

type Actor = string | 'anon' | 'service_role';

/**
 * Runs fn as a Supabase client would: a role, JWT claims and request headers, under row-level
 * security. `org` is what the app would send as x-org-id.
 */
export async function as<T>(db: PGlite, actor: Actor, fn: (tx: Transaction) => Promise<T>, org?: string): Promise<T> {
  const role = actor === 'anon' || actor === 'service_role' ? actor : 'authenticated';
  const claims = role === 'authenticated'
    ? JSON.stringify({ sub: actor, email: (await db.query<{ email: string }>('select email from auth.users where id = $1', [actor])).rows[0]?.email })
    : '';
  const result = await db.transaction(async tx => {
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [claims]);
    await tx.query(`select set_config('request.headers', $1, true)`, [JSON.stringify(org ? { 'x-org-id': org } : {})]);
    await tx.exec(`set local role ${role}`);
    return fn(tx);
  });
  return result as T;
}

export async function rows<R = Record<string, unknown>>(db: PGlite, actor: Actor, sql: string, params: unknown[] = [], org?: string) {
  return as(db, actor, async tx => (await tx.query<R>(sql, params)).rows, org);
}

export const ids = (r: { id?: unknown }[]) => r.map(x => x.id).sort();
