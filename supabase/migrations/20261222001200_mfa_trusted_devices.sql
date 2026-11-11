-- Trusted devices and recognized addresses for two-step verification (Moshe Henig, 2026-11-11: "they shouldn't have
-- to enter the sign-in verification code every time"). After a correct code, the browser can be trusted; then signing
-- in again on that device, or from the same address, needs only the password. A new device or address still gets
-- the code. Defaults until Shulim decides (change mfa_trust_days / mfa_ip_trust_days):
--   * a trusted device: 30 days from the code entered on it (using it doesn't extend it)
--   * a recognized address: the same IP as a code-verified sign-in by the same person within the last 7 days
-- Trust is per person: another person on the same computer still needs their own code. A trusted sign-in counts as
-- verified for that session only (12 hours), like a phone code, so mfa_ok() and bank data work unchanged.
-- The browser keeps a random token; only its SHA-256 is stored.

create or replace function public.mfa_trust_days() returns integer language sql immutable as $$ select 30 $$;
create or replace function public.mfa_ip_trust_days() returns integer language sql immutable as $$ select 7 $$;

create table if not exists public.mfa_trusted_devices (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  token_hash  text not null,
  ip          text,
  user_agent  text,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  last_used_at timestamptz,
  unique (user_id, token_hash)
);
alter table public.mfa_trusted_devices enable row level security;
revoke all on public.mfa_trusted_devices from public, anon, authenticated;

create or replace function public.mfa_token_hash(p_token text) returns text
language sql immutable set search_path = '' as $$ select encode(extensions.digest(p_token, 'sha256'), 'hex') $$;

-- After a correct code in this session: trust this browser for mfa_trust_days().
create or replace function public.mfa_trust_this_device(p_token text, p_user_agent text default null) returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); v_until timestamptz := now() + make_interval(days => public.mfa_trust_days());
begin
  if v_user is null then raise exception 'Sign in first'; end if;
  if not public.mfa_ok() then raise exception 'Enter a verification code first'; end if;
  if p_token is null or p_token !~ '^[A-Za-z0-9_-]{32,128}$' then raise exception 'Bad device token'; end if;
  insert into public.mfa_trusted_devices (user_id, token_hash, ip, user_agent, expires_at)
  values (v_user, public.mfa_token_hash(p_token), public.request_ip(), left(p_user_agent, 300), v_until)
  on conflict (user_id, token_hash) do update set ip = excluded.ip, user_agent = excluded.user_agent, expires_at = excluded.expires_at, created_at = now();
  return v_until;
end $$;

-- At sign-in: if this browser is trusted, or the address is recognized, this session counts as verified.
-- Returns 'device', 'address' or null (the code is needed).
create or replace function public.mfa_use_trusted(p_token text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  c jsonb := public.mfa_claims(); v_user uuid; v_session uuid; v_ip text := public.request_ip(); v_how text; v_id uuid;
begin
  begin
    v_user := (c ->> 'sub')::uuid;
    v_session := (c ->> 'session_id')::uuid;
  exception when others then return null;
  end;
  if v_user is null or v_session is null or v_user is distinct from auth.uid() then return null; end if;
  if p_token ~ '^[A-Za-z0-9_-]{32,128}$' then
    select d.id into v_id from public.mfa_trusted_devices d
    where d.user_id = v_user and d.token_hash = public.mfa_token_hash(p_token) and d.expires_at > now();
    if v_id is not null then v_how := 'device'; end if;
  end if;
  if v_how is null and v_ip is not null then
    select d.id into v_id from public.mfa_trusted_devices d
    where d.user_id = v_user and d.ip = v_ip and d.created_at > now() - make_interval(days => public.mfa_ip_trust_days()) and d.expires_at > now()
    order by d.created_at desc limit 1;
    if v_id is not null then v_how := 'address'; end if;
  end if;
  if v_how is null then return null; end if;
  update public.mfa_trusted_devices set last_used_at = now() where id = v_id;
  insert into public.mfa_phone_sessions (session_id, user_id) values (v_session, v_user)
  on conflict (session_id) do update set verified_at = now(), expires_at = now() + interval '12 hours';
  return v_how;
end $$;

-- How many trusted devices this person has, and forgetting them all.
create or replace function public.mfa_trusted_count() returns integer
language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.mfa_trusted_devices where user_id = auth.uid() and expires_at > now()
$$;
create or replace function public.mfa_forget_devices() returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  delete from public.mfa_trusted_devices where user_id = auth.uid();
  get diagnostics n = row_count;
  return n;
end $$;

revoke execute on function public.mfa_token_hash(text) from public, anon, authenticated;
revoke execute on function public.mfa_trust_this_device(text, text), public.mfa_use_trusted(text), public.mfa_trusted_count(), public.mfa_forget_devices() from public, anon;
grant execute on function public.mfa_trust_this_device(text, text), public.mfa_use_trusted(text), public.mfa_trusted_count(), public.mfa_forget_devices() to authenticated;
