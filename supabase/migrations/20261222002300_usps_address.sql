-- USPS address standardization (Shulim, 2026-11-12): each organization brings its own USPS developer credentials
-- (consumer key and secret from developers.usps.com). Like its Sola, SendGrid and Twilio keys: the secret is
-- encrypted with the same Vault key, nobody signed in can read it back, only the Super Admin sets it, and only the
-- usps-address Edge Function (service role) decrypts it. No platform-wide USPS key: without the organization's own,
-- the address check is simply not offered.
create table public.usps_keys (
  org_id           uuid primary key default public.current_org_id() references public.organizations(id),
  consumer_key     text,
  consumer_secret  bytea,
  environment      text not null default 'production' check (environment in ('production', 'test')),
  updated_by       text default public.current_email(),
  updated_at       timestamptz not null default now()
);
alter table public.usps_keys enable row level security;
revoke all on public.usps_keys from public, anon, authenticated;

-- Super Admin: a key left empty keeps the one on file.
create or replace function public.save_usps_keys(p_consumer_key text, p_consumer_secret text, p_environment text default 'production') returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_key text := nullif(trim(p_consumer_key), ''); v_secret text := nullif(trim(p_consumer_secret), '');
begin
  perform public.require_super_admin('USPS');
  if coalesce(p_environment, 'production') not in ('production', 'test') then raise exception 'Choose production or test'; end if;
  if v_key is not null and v_key !~ '^[A-Za-z0-9._-]{8,200}$' then raise exception 'That doesn''t look like a USPS consumer key'; end if;
  if v_secret is not null and length(v_secret) > 500 then raise exception 'That doesn''t look like a USPS consumer secret'; end if;
  insert into public.usps_keys (org_id, consumer_key, consumer_secret, environment)
  values (v_org, v_key, case when v_secret is not null then extensions.pgp_sym_encrypt(v_secret, public.payment_keys_key()) end, coalesce(p_environment, 'production'))
  on conflict (org_id) do update set
    consumer_key = coalesce(excluded.consumer_key, usps_keys.consumer_key),
    consumer_secret = coalesce(excluded.consumer_secret, usps_keys.consumer_secret),
    environment = excluded.environment,
    updated_by = public.current_email(), updated_at = now();
  if not exists (select 1 from public.usps_keys where org_id = v_org and consumer_key is not null and consumer_secret is not null) then
    raise exception 'Enter both the USPS consumer key and secret';
  end if;
  perform public.write_activity(v_org, 'integration_keys_changed', 'usps_keys', v_org::text, null,
    jsonb_build_object('service', 'usps', 'key_changed', v_key is not null, 'secret_changed', v_secret is not null, 'environment', p_environment));
end $$;

create or replace function public.clear_usps_keys() returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  perform public.require_super_admin('USPS');
  delete from public.usps_keys where org_id = v_org;
  perform public.write_activity(v_org, 'integration_keys_cleared', 'usps_keys', v_org::text, null, jsonb_build_object('service', 'usps'));
end $$;

-- Admins see whether it's set up (the key's last four characters, never the secret).
create or replace function public.usps_keys_status()
returns table (key_hint text, secret_set boolean, environment text, updated_at timestamptz, updated_by text)
language sql stable security definer set search_path = '' as $$
  select case when k.consumer_key is not null then '…' || right(k.consumer_key, 4) end, k.consumer_secret is not null, k.environment, k.updated_at, k.updated_by
  from public.usps_keys k where k.org_id = public.current_org_id() and public.is_admin()
$$;

-- Anyone who works in the portal (admins and fundraisers) may check an address once the organization has keys.
-- The Edge Function asks this as the signed-in person and gets the organization to use.
create or replace function public.usps_check_allowed() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  if v_org is null or not public.is_active_user() then raise exception 'Sign in to check addresses'; end if;
  if not exists (select 1 from public.usps_keys k where k.org_id = v_org and k.consumer_key is not null and k.consumer_secret is not null) then
    raise exception 'USPS address checks aren''t set up for this organization yet';
  end if;
  return v_org;
end $$;

-- For the Edge Function only (service role).
create or replace function public.org_usps_keys(p_org uuid)
returns table (consumer_key text, consumer_secret text, environment text)
language sql stable security definer set search_path = '' as $$
  select k.consumer_key, extensions.pgp_sym_decrypt(k.consumer_secret, public.payment_keys_key()), k.environment
  from public.usps_keys k where k.org_id = p_org
$$;

revoke execute on function public.org_usps_keys(uuid) from public, anon, authenticated;
grant execute on function public.org_usps_keys(uuid) to service_role;
do $$
declare f text;
begin
  foreach f in array array['save_usps_keys(text, text, text)', 'clear_usps_keys()', 'usps_keys_status()', 'usps_check_allowed()'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
