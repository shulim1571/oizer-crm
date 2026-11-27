-- Phase 12: platform operations.
--
-- 1. Public API keys. Each organization's Super Admin creates read-only keys, each limited to the kinds of
--    records it was given (campaigns, donors, donations). Only a SHA-256 hash is kept; the key itself is shown
--    once. Every request is checked, rate limited (60 a minute per key) and answered by api_request(), which
--    only the api Edge Function (service role) can call.
-- 2. Web addresses. Each organization can have its default address (<slug>.trubase.org) and up to five of its
--    own (donate.example.org). The domains Edge Function asks Cloudflare for the address and its certificate;
--    these tables keep what it was told and what the organization has to put in its DNS. An address starts
--    leading to the organization only once Cloudflare reports both the address and its certificate active.
-- 3. The "Powered by" footer, per organization: on or off, its words and its link.
--
-- Uptime monitoring lives outside Supabase on purpose (a Cloudflare Worker), so it can report Supabase being down.

-- ---------------------------------------------------------------------------
-- 1. Public API keys
-- ---------------------------------------------------------------------------
create table public.api_keys (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  name          text not null check (length(trim(name)) between 1 and 80),
  prefix        text not null unique,
  key_hash      bytea not null,
  scopes        text[] not null check (scopes <@ array['campaigns','donors','donations'] and cardinality(scopes) > 0),
  created_by    text default public.current_email(),
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  revoked_by    text
);
create index on public.api_keys (org_id);
alter table public.api_keys enable row level security;
revoke all on public.api_keys from public, anon, authenticated;

-- Requests per key per minute. One row per key: each request replaces an older minute's row.
create table public.api_rate (
  key_id        uuid primary key references public.api_keys(id) on delete cascade,
  window_start  timestamptz not null,
  requests      int not null
);
alter table public.api_rate enable row level security;
revoke all on public.api_rate from public, anon, authenticated;

create or replace function public.api_rate_limit() returns int language sql immutable as $$ select 60 $$;

create or replace function public.require_org_super_admin(p_what text) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_super_admin() then raise exception 'Only the Super Admin can %', p_what; end if;
end $$;

-- Returns the whole key, once. It looks like oz_live_<8 characters>_<48 characters>.
create or replace function public.create_api_key(p_name text, p_scopes text[]) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  v_prefix text := encode(extensions.gen_random_bytes(4), 'hex');
  v_key text := 'oz_live_' || v_prefix || '_' || encode(extensions.gen_random_bytes(24), 'hex');
  v_scopes text[] := (select coalesce(array_agg(distinct s order by s), '{}') from unnest(p_scopes) s);
  v_id uuid;
begin
  perform public.require_org_super_admin('create API keys');
  if nullif(trim(p_name), '') is null then raise exception 'Give the key a name, such as the system that will use it'; end if;
  if cardinality(v_scopes) = 0 then raise exception 'Choose what the key may read'; end if;
  if not v_scopes <@ array['campaigns','donors','donations'] then raise exception 'A key can read campaigns, donors and donations'; end if;
  insert into public.api_keys (org_id, name, prefix, key_hash, scopes)
  values (v_org, trim(p_name), v_prefix, extensions.digest(v_key, 'sha256'), v_scopes)
  returning id into v_id;
  perform public.write_activity(v_org, 'api_key_created', 'api_keys', v_id::text, null,
    jsonb_build_object('name', trim(p_name), 'prefix', v_prefix, 'scopes', v_scopes));
  return v_key;
end $$;

create or replace function public.revoke_api_key(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_name text;
begin
  perform public.require_org_super_admin('revoke API keys');
  update public.api_keys set revoked_at = now(), revoked_by = public.current_email()
  where id = p_id and org_id = v_org and revoked_at is null
  returning name into v_name;
  if v_name is null then raise exception 'That key isn''t active in this organization'; end if;
  perform public.write_activity(v_org, 'api_key_revoked', 'api_keys', p_id::text, null, jsonb_build_object('name', v_name));
end $$;

-- What the settings screen lists (admins). Never the hash.
create or replace function public.list_api_keys()
returns table (id uuid, name text, prefix text, scopes text[], created_by text, created_at timestamptz,
               last_used_at timestamptz, revoked_at timestamptz, revoked_by text)
language sql stable security definer set search_path = '' as $$
  select k.id, k.name, k.prefix, k.scopes, k.created_by, k.created_at, k.last_used_at, k.revoked_at, k.revoked_by
  from public.api_keys k
  where k.org_id = public.current_org_id() and public.is_admin()
  order by k.revoked_at is not null, k.created_at desc
$$;

-- One API request, from the api Edge Function. Errors carry the HTTP status as their SQLSTATE
-- (PT401, PT403, PT404, PT422, PT429), which the function passes on.
--   p_resource: campaigns | donors | donations
--   p_params:   id (one record), limit (1-100, default 50), after (the previous page's next), updated_since,
--               and for donations campaign_id and donor_id
create or replace function public.api_request(p_key text, p_resource text, p_params jsonb default '{}')
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  k public.api_keys;
  v_window timestamptz := date_trunc('minute', now());
  v_count int;
  v_limit int;
  v_after text := nullif(p_params->>'after', '');
  v_id text := nullif(p_params->>'id', '');
  v_since timestamptz;
  v_rows jsonb;
  v_next text;
begin
  -- Who is asking
  if p_key !~ '^oz_live_[0-9a-f]{8}_[0-9a-f]{48}$' then
    raise exception 'Send an API key as: Authorization: Bearer oz_live_…' using errcode = 'PT401';
  end if;
  select * into k from public.api_keys
  where prefix = substr(p_key, 9, 8) and key_hash = extensions.digest(p_key, 'sha256') and revoked_at is null;
  if k.id is null or not exists (select 1 from public.organizations o where o.id = k.org_id and o.status = 'active') then
    raise exception 'That API key isn''t valid, or was revoked' using errcode = 'PT401';
  end if;

  -- How often
  insert into public.api_rate as r (key_id, window_start, requests) values (k.id, v_window, 1)
  on conflict (key_id) do update
    set requests = case when r.window_start = excluded.window_start then r.requests + 1 else 1 end,
        window_start = excluded.window_start
  returning requests into v_count;
  if v_count > public.api_rate_limit() then
    raise exception 'Too many requests: % a minute per key. Try again in % seconds.', public.api_rate_limit(),
      ceil(extract(epoch from v_window + interval '1 minute' - now()))::int using errcode = 'PT429';
  end if;
  if k.last_used_at is null or k.last_used_at < now() - interval '1 minute' then
    update public.api_keys set last_used_at = now() where id = k.id;
  end if;

  -- What
  if p_resource not in ('campaigns','donors','donations') then
    raise exception 'Unknown resource %. Use campaigns, donors or donations.', p_resource using errcode = 'PT404';
  end if;
  if not p_resource = any(k.scopes) then
    raise exception 'This key may not read %', p_resource using errcode = 'PT403';
  end if;
  begin
    v_limit := coalesce((p_params->>'limit')::int, 50);
    v_since := (p_params->>'updated_since')::timestamptz;
  exception when others then
    raise exception 'limit is a number and updated_since a date and time such as 2026-11-01T00:00:00Z' using errcode = 'PT422';
  end;
  if v_limit not between 1 and 100 then raise exception 'limit is between 1 and 100' using errcode = 'PT422'; end if;
  if v_id is not null then v_limit := 1; end if;

  if p_resource = 'campaigns' then
    select coalesce(jsonb_agg(x order by x->>'id' collate "C"), '[]') into v_rows from (
      select jsonb_build_object(
        'id', c.id, 'name', coalesce(c.campaign_name, c.internal_name), 'external_name', c.external_name,
        'internal_name', c.internal_name, 'status', c.status, 'goal', c.goal, 'parent_campaign_id', c.parent_campaign_id,
        'manager_id', c.manager_id, 'featured', c.featured, 'archived_at', c.archived_at, 'closed_at', c.closed_at,
        'created_at', c.created_at, 'updated_at', c.updated_at) x
      from public.campaigns c
      where c.org_id = k.org_id and c.deleted_at is null
        and (v_id is null or c.id = v_id)
        and (v_after is null or c.id collate "C" > v_after)
        and (v_since is null or c.updated_at >= v_since)
      order by c.id collate "C" limit v_limit + 1) s;
  elsif p_resource = 'donors' then
    select coalesce(jsonb_agg(x order by x->>'id' collate "C"), '[]') into v_rows from (
      select jsonb_build_object(
        'id', d.id, 'display_name', d.display_name, 'title', d.english_title, 'first_name', d.first_name,
        'last_name', d.last_name, 'yiddish_name', d.yiddish_name, 'email', d.email, 'phone', d.phone,
        'address', d.address, 'country', d.country, 'merged_into', d.merged_into,
        'created_at', d.created_at, 'updated_at', d.updated_at) x
      from public.donors d
      where d.org_id = k.org_id and d.deleted_at is null
        and (v_id is null or d.id = v_id)
        and (v_after is null or d.id collate "C" > v_after)
        and (v_since is null or d.updated_at >= v_since)
      order by d.id collate "C" limit v_limit + 1) s;
  else
    select coalesce(jsonb_agg(x order by x->>'id' collate "C"), '[]') into v_rows from (
      select jsonb_build_object(
        'id', n.id, 'campaign_id', n.campaign_id, 'donor_id', n.donor_id, 'status', n.status, 'type', n.type,
        'amount', n.amount, 'fee', n.fee, 'net', n.net_donation, 'payment_method', n.payment_method,
        'source', n.source, 'check_number', n.check_number, 'check_date', n.check_date, 'anonymous', n.anonymous,
        'pledge_id', n.pledge_id, 'created_at', n.created_at, 'updated_at', n.updated_at) x
      from public.donations n
      where n.org_id = k.org_id and n.deleted_at is null
        and (v_id is null or n.id = v_id)
        and (v_after is null or n.id collate "C" > v_after)
        and (v_since is null or n.updated_at >= v_since)
        and (p_params->>'campaign_id' is null or n.campaign_id = p_params->>'campaign_id')
        and (p_params->>'donor_id' is null or n.donor_id = p_params->>'donor_id')
      order by n.id collate "C" limit v_limit + 1) s;
  end if;

  if v_id is not null then
    if jsonb_array_length(v_rows) = 0 then
      raise exception 'No % with id %', rtrim(p_resource, 's'), v_id using errcode = 'PT404';
    end if;
    return jsonb_build_object('data', v_rows->0, 'rate', jsonb_build_object('limit', public.api_rate_limit(),
      'remaining', public.api_rate_limit() - v_count, 'reset', ceil(extract(epoch from v_window + interval '1 minute' - now()))::int));
  end if;
  if jsonb_array_length(v_rows) > v_limit then
    v_rows := v_rows - v_limit;
    v_next := v_rows->(v_limit - 1)->>'id';
  end if;
  return jsonb_build_object('data', v_rows, 'next', v_next,
    'rate', jsonb_build_object('limit', public.api_rate_limit(), 'remaining', public.api_rate_limit() - v_count,
      'reset', ceil(extract(epoch from v_window + interval '1 minute' - now()))::int));
end $$;

-- ---------------------------------------------------------------------------
-- 2. Web addresses
-- ---------------------------------------------------------------------------
create or replace function public.platform_domain() returns text language sql immutable as $$ select 'trubase.org' $$;

-- Lowercase, without a scheme, path, port or trailing dot. Null when it isn't a usable hostname.
create or replace function public.clean_hostname(p text) returns text
language sql immutable as $$
  select case when h ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$' and length(h) <= 253 then h end
  from (select rtrim(split_part(split_part(regexp_replace(lower(trim(coalesce(p, ''))), '^[a-z]+://', ''), '/', 1), ':', 1), '.') h) s
$$;

create table public.org_web_addresses (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  hostname      text not null unique check (hostname = public.clean_hostname(hostname)),
  kind          text not null check (kind in ('subdomain','custom')),
  provider      text check (provider in ('pages','saas')),
  provider_id   text,
  status        text not null default 'requested' check (status in ('requested','pending','active','failed','removing')),
  ssl_status    text,
  dns_records   jsonb not null default '[]',   -- [{type, name, value, purpose}] for the organization's DNS
  last_error    text,
  created_by    text default public.current_email(),
  created_at    timestamptz not null default now(),
  checked_at    timestamptz,
  activated_at  timestamptz
);
create index on public.org_web_addresses (org_id);
alter table public.org_web_addresses enable row level security;
revoke all on public.org_web_addresses from public, anon, authenticated;

create or replace function public.max_custom_addresses() returns int language sql immutable as $$ select 5 $$;

-- The Super Admin asks for an address; the domains function then asks Cloudflare for it.
-- p_kind 'subdomain' takes no hostname: it is always <slug>.trubase.org.
create or replace function public.request_web_address(p_kind text, p_hostname text default null)
returns table (id uuid, hostname text, kind text)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  v_host text;
  v_slug text := (select o.slug from public.organizations o where o.id = v_org);
  v_id uuid;
begin
  perform public.require_org_super_admin('set up web addresses');
  if p_kind = 'subdomain' then
    v_host := public.clean_hostname(v_slug || '.' || public.platform_domain());
    if v_host is null then raise exception 'This organization''s short name can''t be used as a web address'; end if;
  elsif p_kind = 'custom' then
    v_host := public.clean_hostname(p_hostname);
    if v_host is null then raise exception 'Enter a web address such as donate.yourorg.org'; end if;
    if v_host = public.platform_domain() or v_host like '%.' || public.platform_domain() then
      raise exception 'Addresses ending in % are set up by the platform. Use your own domain here.', public.platform_domain();
    end if;
    if array_length(string_to_array(v_host, '.'), 1) < 3 then
      raise exception 'Use a subdomain such as donate.%: a bare domain can''t point here', v_host;
    end if;
    if (select count(*) from public.org_web_addresses a where a.org_id = v_org and a.kind = 'custom') >= public.max_custom_addresses() then
      raise exception 'An organization can have up to % of its own addresses', public.max_custom_addresses();
    end if;
  else
    raise exception 'Unknown kind of address %', p_kind;
  end if;
  if exists (select 1 from public.org_domains d where d.hostname = v_host)
     or exists (select 1 from public.org_web_addresses a where a.hostname = v_host) then
    raise exception '% is already set up', v_host;
  end if;
  insert into public.org_web_addresses (org_id, hostname, kind) values (v_org, v_host, p_kind) returning org_web_addresses.id into v_id;
  perform public.write_activity(v_org, 'web_address_requested', 'org_web_addresses', v_id::text, null,
    jsonb_build_object('hostname', v_host, 'kind', p_kind));
  return query select v_id, v_host, p_kind;
end $$;

-- The Super Admin removes an address. Returns what the domains function needs to remove it at Cloudflare.
create or replace function public.remove_web_address(p_id uuid)
returns table (id uuid, hostname text, provider text, provider_id text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); a public.org_web_addresses;
begin
  perform public.require_org_super_admin('remove web addresses');
  update public.org_web_addresses w set status = 'removing' where w.id = p_id and w.org_id = v_org returning * into a;
  if a.id is null then raise exception 'That address isn''t part of this organization'; end if;
  delete from public.org_domains d where d.hostname = a.hostname and d.org_id = v_org;
  perform public.write_activity(v_org, 'web_address_removed', 'org_web_addresses', a.id::text, null, jsonb_build_object('hostname', a.hostname));
  return query select a.id, a.hostname, a.provider, a.provider_id;
end $$;

-- What the setup screen shows (admins).
create or replace function public.web_addresses()
returns table (id uuid, hostname text, kind text, provider text, provider_id text, status text, ssl_status text, dns_records jsonb,
               last_error text, created_by text, created_at timestamptz, checked_at timestamptz, activated_at timestamptz,
               leads_here boolean)
language sql stable security definer set search_path = '' as $$
  select a.id, a.hostname, a.kind, a.provider, a.provider_id, a.status, a.ssl_status, a.dns_records, a.last_error, a.created_by,
         a.created_at, a.checked_at, a.activated_at,
         exists (select 1 from public.org_domains d where d.hostname = a.hostname and d.org_id = a.org_id)
  from public.org_web_addresses a
  where a.org_id = public.current_org_id() and public.is_admin() and a.status <> 'removing'
  union all
  -- Addresses set up before this screen existed, such as oizer.trubase.org.
  select null, d.hostname, case when d.hostname like '%.' || public.platform_domain() then 'subdomain' else 'custom' end,
         null, null, 'active', 'active', '[]'::jsonb, null, null, null, null, null, true
  from public.org_domains d
  where d.org_id = public.current_org_id() and public.is_admin()
    and not exists (select 1 from public.org_web_addresses a where a.hostname = d.hostname)
  order by 3 desc, 2
$$;

-- For the domains function (service role): what Cloudflare said. Active address and certificate together
-- make the address lead to the organization.
create or replace function public.record_web_address(p_id uuid, p_provider text, p_provider_id text, p_status text,
                                                     p_ssl_status text, p_dns_records jsonb, p_error text)
returns void
language plpgsql security definer set search_path = '' as $$
declare a public.org_web_addresses;
begin
  update public.org_web_addresses w set
    provider = coalesce(p_provider, w.provider), provider_id = coalesce(p_provider_id, w.provider_id),
    status = case when w.status = 'removing' then w.status else p_status end,
    ssl_status = p_ssl_status, dns_records = coalesce(p_dns_records, w.dns_records), last_error = p_error,
    checked_at = now(),
    activated_at = case when p_status = 'active' and w.activated_at is null then now() else w.activated_at end
  where w.id = p_id returning * into a;
  if a.id is null then raise exception 'No such address'; end if;
  if a.status = 'active' and a.ssl_status = 'active' then
    insert into public.org_domains (hostname, org_id) values (a.hostname, a.org_id) on conflict do nothing;
  elsif a.status <> 'active' then
    delete from public.org_domains d where d.hostname = a.hostname and d.org_id = a.org_id;
  end if;
end $$;

create or replace function public.forget_web_address(p_id uuid) returns void
language sql security definer set search_path = '' as $$
  delete from public.org_web_addresses where id = p_id and status = 'removing'
$$;

-- The addresses still waiting on DNS, for the scheduled re-check.
create or replace function public.web_addresses_to_check()
returns table (id uuid, org_id uuid, hostname text, kind text, provider text, provider_id text)
language sql stable security definer set search_path = '' as $$
  select a.id, a.org_id, a.hostname, a.kind, a.provider, a.provider_id from public.org_web_addresses a
  where a.status in ('requested','pending') or (a.status = 'active' and a.ssl_status is distinct from 'active')
  order by a.checked_at nulls first limit 50
$$;

-- Every 10 minutes, while an address waits on its DNS, the domains function asks Cloudflare again.
create or replace function public.kick_web_addresses() returns void
language plpgsql security definer set search_path = '' as $$
declare v_url text; v_token text;
begin
  if not exists (select 1 from public.web_addresses_to_check()) then return; end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into v_token from vault.decrypted_secrets where name = 'messaging_cron_token';
  if v_url is null or v_token is null then return; end if;
  perform net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/domains',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-token', v_token),
    body := '{"action":"recheck"}'::jsonb);
end $$;
revoke execute on function public.kick_web_addresses() from public, anon, authenticated;
select cron.schedule('web_addresses', '*/10 * * * *', $$select public.kick_web_addresses()$$);

-- ---------------------------------------------------------------------------
-- 3. "Powered by" footer
-- ---------------------------------------------------------------------------
create table public.org_footer (
  org_id      uuid primary key references public.organizations(id) on delete cascade,
  enabled     boolean not null default false,
  text        text check (length(text) <= 80),
  url         text check (url ~ '^https://[^\s]+$' and length(url) <= 300),
  updated_by  text default public.current_email(),
  updated_at  timestamptz not null default now()
);
alter table public.org_footer enable row level security;
revoke all on public.org_footer from public, anon, authenticated;

create or replace function public.save_org_footer(p_enabled boolean, p_text text, p_url text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_text text := nullif(trim(p_text), ''); v_url text := nullif(trim(p_url), '');
begin
  perform public.require_org_super_admin('change the footer');
  if p_enabled and v_text is null then raise exception 'Enter the footer''s words, such as Powered by …'; end if;
  if length(v_text) > 80 then raise exception 'Keep the footer to 80 characters'; end if;
  if v_url is not null and v_url !~ '^https://[^\s]+$' then raise exception 'The link starts with https://'; end if;
  insert into public.org_footer (org_id, enabled, text, url) values (v_org, coalesce(p_enabled, false), v_text, v_url)
  on conflict (org_id) do update set enabled = excluded.enabled, text = excluded.text, url = excluded.url,
    updated_by = public.current_email(), updated_at = now();
  perform public.write_activity(v_org, 'footer_changed', 'org_footer', v_org::text, null,
    jsonb_build_object('enabled', coalesce(p_enabled, false), 'text', v_text, 'url', v_url));
end $$;

-- Public: the footer for an active organization's pages, when it is switched on.
create or replace function public.org_footer(p_org uuid)
returns table (enabled boolean, text text, url text)
language sql stable security definer set search_path = '' as $$
  select f.enabled, f.text, f.url from public.org_footer f
  join public.organizations o on o.id = f.org_id and o.status = 'active'
  where f.org_id = p_org and (f.enabled or public.is_admin())
$$;

-- ---------------------------------------------------------------------------
-- Who may call what
-- ---------------------------------------------------------------------------
revoke execute on function public.api_request(text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.record_web_address(uuid, text, text, text, text, jsonb, text) from public, anon, authenticated;
revoke execute on function public.forget_web_address(uuid) from public, anon, authenticated;
revoke execute on function public.web_addresses_to_check() from public, anon, authenticated;
revoke execute on function public.require_org_super_admin(text) from public, anon;
grant execute on function public.api_request(text, text, jsonb) to service_role;
grant execute on function public.record_web_address(uuid, text, text, text, text, jsonb, text) to service_role;
grant execute on function public.forget_web_address(uuid) to service_role;
grant execute on function public.web_addresses_to_check() to service_role;

revoke execute on function public.create_api_key(text, text[]) from public, anon;
revoke execute on function public.revoke_api_key(uuid) from public, anon;
revoke execute on function public.list_api_keys() from public, anon;
revoke execute on function public.request_web_address(text, text) from public, anon;
revoke execute on function public.remove_web_address(uuid) from public, anon;
revoke execute on function public.web_addresses() from public, anon;
revoke execute on function public.save_org_footer(boolean, text, text) from public, anon;
grant execute on function public.org_footer(uuid) to anon, authenticated;
