-- Two-step verification by text or voice call (Shulim, 2026-11-11), alongside the authenticator app (TOTP).
-- Codes are sent from Oizer's Twilio number by the phone-code Edge Function with the Twilio credentials in Supabase
-- secrets (not Supabase's paid phone MFA add-on).
--
--   * A user adds a phone under Account security and verifies it with a code; at sign-in they get a code by text or
--     call (their choice, resend allowed).
--   * Codes: 6 digits, stored only as a bcrypt hash, expire after 10 minutes, single use, 5 wrong tries end the code.
--   * Sends are limited to 5 per hour per user and 5 per hour per phone number.
--   * A correct code is recorded by the database for the exact session that asked for it (the session_id in the
--     login's token). mfa_ok() accepts that record exactly like an authenticator-app session (aal2), so the bank and
--     reconciliation requirement from 20261217000000_mfa_for_bank_data.sql treats both the same. A code requested
--     in one session can't verify another. The record lasts as long as a session can (12 hours).
--   * Sends, verifications, failures and phone changes are written to the activity log, never the code.

create table public.mfa_phones (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  phone       text not null check (phone = public.normalize_phone(phone)),
  channel     text not null default 'sms' check (channel in ('sms', 'call')),
  verified_at timestamptz,
  added_at    timestamptz not null default now()
);
alter table public.mfa_phones enable row level security;
revoke all on public.mfa_phones from public, anon, authenticated;

create table public.mfa_phone_codes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  session_id  uuid not null,
  phone       text not null,
  channel     text not null check (channel in ('sms', 'call')),
  purpose     text not null check (purpose in ('enroll', 'signin')),
  code_hash   text,                                   -- set once, when the code is issued for sending
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '10 minutes',
  attempts    integer not null default 0,
  used_at     timestamptz
);
create index mfa_phone_codes_user_recent on public.mfa_phone_codes (user_id, created_at desc);
create index mfa_phone_codes_phone_recent on public.mfa_phone_codes (phone, created_at desc);
alter table public.mfa_phone_codes enable row level security;
revoke all on public.mfa_phone_codes from public, anon, authenticated;

create table public.mfa_phone_sessions (
  session_id  uuid primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  verified_at timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '12 hours'
);
alter table public.mfa_phone_sessions enable row level security;
revoke all on public.mfa_phone_sessions from public, anon, authenticated;

create or replace function public.mfa_claims() returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;

-- The session is verified: an authenticator-app code (aal2) or a phone code the database recorded for this session.
create or replace function public.mfa_ok() returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare c jsonb := public.mfa_claims(); v_session uuid; v_user uuid;
begin
  if coalesce(c ->> 'aal', 'aal1') = 'aal2' then return true; end if;
  begin
    v_session := (c ->> 'session_id')::uuid;
    v_user := (c ->> 'sub')::uuid;
  exception when others then return false;
  end;
  if v_session is null or v_user is null then return false; end if;
  return exists (select 1 from public.mfa_phone_sessions s where s.session_id = v_session and s.user_id = v_user and s.expires_at > now());
end $$;

-- Activity log entry for a user (also from the service role, where auth.uid() is empty). Never the code.
create or replace function public.mfa_log(p_user uuid, p_action text, p_changes jsonb) returns void
language sql security definer set search_path = '' as $$
  insert into public.activity_log (org_id, user_id, user_email, action, table_name, record_id, changes)
  values ((select case when count(*) = 1 then min(m.org_id::text)::uuid end from public.org_members m where m.user_id = p_user),
          p_user, (select u.email from auth.users u where u.id = p_user), p_action, 'mfa_phones', p_user::text, p_changes)
$$;

create or replace function public.mfa_mask(p_phone text) returns text
language sql immutable set search_path = '' as $$
  select case when p_phone is null then null else '•••-•••-' || right(p_phone, 4) end
$$;

-- For Account security and the sign-in screen: the person's phone (masked) and whether this session is verified.
create or replace function public.mfa_phone_status()
returns table (phone_masked text, channel text, verified boolean, session_verified boolean)
language sql stable security definer set search_path = '' as $$
  select public.mfa_mask(p.phone), coalesce(p.channel, 'sms'), p.verified_at is not null, public.mfa_ok()
  from (select auth.uid() uid) me
  left join public.mfa_phones p on p.user_id = me.uid
  where me.uid is not null
$$;

-- Step 1, as the user: checks and limits, then a pending code for this session. Returns its id; never a code.
create or replace function public.mfa_phone_start(p_purpose text, p_channel text, p_phone text default null)
returns table (challenge_id uuid, phone_masked text)
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  c jsonb := public.mfa_claims();
  v_session uuid;
  v_phone text;
  p public.mfa_phones;
  v_id uuid;
begin
  if v_user is null then raise exception 'Sign in first'; end if;
  begin v_session := (c ->> 'session_id')::uuid; exception when others then v_session := null; end;
  if v_session is null then raise exception 'Sign in again, then ask for a code'; end if;
  if p_channel not in ('sms', 'call') then raise exception 'Choose text or call'; end if;
  select * into p from public.mfa_phones x where x.user_id = v_user;

  if p_purpose = 'enroll' then
    v_phone := public.normalize_phone(p_phone);
    if v_phone is null then raise exception 'Enter a valid phone number'; end if;
    -- Replacing a verified phone needs a verified session, so a password alone can't move the second step elsewhere.
    if p.verified_at is not null and not public.mfa_ok() then
      raise exception 'Verify this session with your current two-step method before changing the phone';
    end if;
  elsif p_purpose = 'signin' then
    if p.verified_at is null then raise exception 'No verified phone on this account'; end if;
    v_phone := p.phone;
  else
    raise exception 'Unknown purpose';
  end if;

  perform pg_advisory_xact_lock(hashtext('mfa:' || v_user::text));
  if (select count(*) from public.mfa_phone_codes x where x.user_id = v_user and x.created_at > now() - interval '1 hour') >= 5 then
    perform public.mfa_log(v_user, 'mfa_code_rate_limited', jsonb_build_object('scope', 'user', 'channel', p_channel));
    raise exception 'Too many codes requested. Try again in an hour';
  end if;
  if (select count(*) from public.mfa_phone_codes x where x.phone = v_phone and x.created_at > now() - interval '1 hour') >= 5 then
    perform public.mfa_log(v_user, 'mfa_code_rate_limited', jsonb_build_object('scope', 'phone', 'channel', p_channel));
    raise exception 'Too many codes sent to this phone. Try again in an hour';
  end if;

  insert into public.mfa_phone_codes (user_id, session_id, phone, channel, purpose)
  values (v_user, v_session, v_phone, p_channel, p_purpose) returning id into v_id;
  return query select v_id, public.mfa_mask(v_phone);
end $$;

-- Step 2, service role only (the phone-code function): makes the code once, keeps only its hash, and returns it
-- for sending. A challenge older than a minute or already issued gets nothing.
create or replace function public.mfa_phone_issue(p_challenge uuid)
returns table (phone text, channel text, code text, purpose text)
language plpgsql security definer set search_path = '' as $$
declare r public.mfa_phone_codes; v_code text;
begin
  select * into r from public.mfa_phone_codes x where x.id = p_challenge for update;
  if r.id is null or r.code_hash is not null or r.created_at < now() - interval '1 minute' then return; end if;
  v_code := lpad(((('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint) % 1000000)::text, 6, '0');
  update public.mfa_phone_codes set code_hash = extensions.crypt(v_code, extensions.gen_salt('bf', 6)) where id = r.id;
  perform public.mfa_log(r.user_id, 'mfa_code_sent', jsonb_build_object('channel', r.channel, 'purpose', r.purpose, 'phone', public.mfa_mask(r.phone)));
  return query select r.phone, r.channel, v_code, r.purpose;
end $$;

-- Step 3, as the user: check a code. Returns 'ok', 'wrong', 'expired', 'used', 'locked' or 'not_found' (no
-- exception, so a wrong try is counted). A code only verifies the session that requested it. On success the
-- database records this session as verified; for 'enroll' the phone becomes the account's verified phone.
create or replace function public.mfa_phone_verify(p_challenge uuid, p_code text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  c jsonb := public.mfa_claims();
  v_session uuid;
  r public.mfa_phone_codes;
begin
  if v_user is null then return 'not_found'; end if;
  begin v_session := (c ->> 'session_id')::uuid; exception when others then v_session := null; end;
  select * into r from public.mfa_phone_codes x where x.id = p_challenge and x.user_id = v_user for update;
  if r.id is null or r.code_hash is null then return 'not_found'; end if;
  if r.session_id is distinct from v_session then
    perform public.mfa_log(v_user, 'mfa_code_failed', jsonb_build_object('reason', 'other_session'));
    return 'not_found';
  end if;
  if r.used_at is not null then return 'used'; end if;
  if r.expires_at <= now() then return 'expired'; end if;
  if r.attempts >= 5 then return 'locked'; end if;

  update public.mfa_phone_codes set attempts = attempts + 1 where id = r.id;
  if extensions.crypt(regexp_replace(coalesce(p_code, ''), '\D', '', 'g'), r.code_hash) <> r.code_hash then
    perform public.mfa_log(v_user, 'mfa_code_failed', jsonb_build_object('reason', 'wrong_code', 'attempt', r.attempts + 1, 'channel', r.channel));
    return case when r.attempts + 1 >= 5 then 'locked' else 'wrong' end;
  end if;

  update public.mfa_phone_codes set used_at = now() where id = r.id;
  if r.purpose = 'enroll' then
    insert into public.mfa_phones (user_id, phone, channel, verified_at) values (v_user, r.phone, r.channel, now())
    on conflict (user_id) do update set phone = excluded.phone, channel = excluded.channel, verified_at = now();
    perform public.mfa_log(v_user, 'mfa_phone_added', jsonb_build_object('phone', public.mfa_mask(r.phone), 'channel', r.channel));
  end if;
  insert into public.mfa_phone_sessions (session_id, user_id) values (v_session, v_user)
  on conflict (session_id) do update set verified_at = now(), expires_at = now() + interval '12 hours'
    where public.mfa_phone_sessions.user_id = v_user;
  perform public.mfa_log(v_user, 'mfa_code_verified', jsonb_build_object('channel', r.channel, 'purpose', r.purpose));
  return 'ok';
end $$;

-- Text or call by default.
create or replace function public.mfa_phone_set_channel(p_channel text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_channel not in ('sms', 'call') then raise exception 'Choose text or call'; end if;
  update public.mfa_phones set channel = p_channel where user_id = auth.uid() and verified_at is not null;
  if not found then raise exception 'Add and verify a phone first'; end if;
end $$;

-- Remove the phone: needs a verified session.
create or replace function public.mfa_phone_remove() returns void
language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid();
begin
  if v_user is null then raise exception 'Sign in first'; end if;
  if not public.mfa_ok() then raise exception 'Verify this session with a code before removing the phone'; end if;
  delete from public.mfa_phones where user_id = v_user;
  perform public.mfa_log(v_user, 'mfa_phone_removed', '{}'::jsonb);
end $$;

revoke execute on function public.mfa_claims() from public, anon;
revoke execute on function public.mfa_log(uuid, text, jsonb) from public, anon, authenticated;
revoke execute on function public.mfa_phone_issue(uuid) from public, anon, authenticated;
grant execute on function public.mfa_phone_issue(uuid) to service_role;
do $$
declare f text;
begin
  foreach f in array array['mfa_phone_status()', 'mfa_phone_start(text, text, text)', 'mfa_phone_verify(uuid, text)',
                           'mfa_phone_set_channel(text)', 'mfa_phone_remove()', 'mfa_ok()'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
