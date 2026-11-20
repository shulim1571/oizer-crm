-- Every organization brings its own SendGrid, Twilio and Turnstile keys, like its Sola keys. Until it does, the
-- platform's keys (Edge Function secrets) are used, so nothing stops working. Secret parts are encrypted with
-- the same Vault key as the Sola keys, nobody signed in can read them, and only the Super Admin changes them.
-- Delivery reports and texts signed with an organization's own keys arrive at its own webhook address
-- (?org=<id>) and can only touch that organization's messages.

create table public.integration_keys (
  org_id                uuid primary key default public.current_org_id() references public.organizations(id),
  sendgrid_key          bytea,
  sendgrid_webhook_key  text,
  twilio_sid            text,
  twilio_token          bytea,
  turnstile_site_key    text,
  turnstile_secret      bytea,
  updated_by            text default public.current_email(),
  updated_at            timestamptz not null default now()
);
alter table public.integration_keys enable row level security;
revoke all on public.integration_keys from public, anon, authenticated;
-- No row-change log here: it would copy the encrypted keys into the activity log. The save functions log what changed.

create or replace function public.require_super_admin(p_what text) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_super_admin() then raise exception 'Only the Super Admin can change the % keys', p_what; end if;
end $$;

-- ---------------------------------------------------------------------------
-- Saving (Super Admin). A key left empty keeps the one on file.
-- ---------------------------------------------------------------------------
create or replace function public.save_email_keys(p_api_key text, p_webhook_key text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_api text := nullif(trim(p_api_key), ''); v_hook text := nullif(regexp_replace(coalesce(p_webhook_key, ''), '\s', '', 'g'), '');
begin
  perform public.require_super_admin('SendGrid');
  if v_api is not null and v_api !~ '^SG\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' then raise exception 'That isn''t a SendGrid API key: it starts with SG.'; end if;
  if v_hook is not null and v_hook !~ '^[A-Za-z0-9+/]+=*$' then raise exception 'The webhook verification key is the long text SendGrid shows, without line breaks'; end if;
  insert into public.integration_keys (org_id, sendgrid_key, sendgrid_webhook_key)
  values (v_org, case when v_api is not null then extensions.pgp_sym_encrypt(v_api, public.payment_keys_key()) end, v_hook)
  on conflict (org_id) do update set
    sendgrid_key = coalesce(excluded.sendgrid_key, integration_keys.sendgrid_key),
    sendgrid_webhook_key = coalesce(excluded.sendgrid_webhook_key, integration_keys.sendgrid_webhook_key),
    updated_by = public.current_email(), updated_at = now();
  if not exists (select 1 from public.integration_keys where org_id = v_org and sendgrid_key is not null) then
    raise exception 'Enter the SendGrid API key';
  end if;
  perform public.write_activity(v_org, 'integration_keys_changed', 'integration_keys', v_org::text, null,
    jsonb_build_object('service', 'sendgrid', 'api_key_changed', v_api is not null, 'webhook_key_changed', v_hook is not null));
end $$;

create or replace function public.save_sms_keys(p_sid text, p_token text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_sid text := nullif(trim(p_sid), ''); v_token text := nullif(trim(p_token), '');
begin
  perform public.require_super_admin('Twilio');
  if v_sid is not null and v_sid !~ '^AC[0-9a-fA-F]{32}$' then raise exception 'The Account SID starts with AC and has 34 characters'; end if;
  if v_token is not null and v_token !~ '^[0-9a-fA-F]{32}$' then raise exception 'The Auth Token has 32 letters and numbers'; end if;
  insert into public.integration_keys (org_id, twilio_sid, twilio_token)
  values (v_org, v_sid, case when v_token is not null then extensions.pgp_sym_encrypt(v_token, public.payment_keys_key()) end)
  on conflict (org_id) do update set
    twilio_sid = coalesce(excluded.twilio_sid, integration_keys.twilio_sid),
    twilio_token = coalesce(excluded.twilio_token, integration_keys.twilio_token),
    updated_by = public.current_email(), updated_at = now();
  if not exists (select 1 from public.integration_keys where org_id = v_org and twilio_sid is not null and twilio_token is not null) then
    raise exception 'Enter both the Account SID and the Auth Token';
  end if;
  perform public.write_activity(v_org, 'integration_keys_changed', 'integration_keys', v_org::text, null,
    jsonb_build_object('service', 'twilio', 'sid_changed', v_sid is not null, 'token_changed', v_token is not null));
end $$;

create or replace function public.save_turnstile_keys(p_site_key text, p_secret text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_site text := nullif(trim(p_site_key), ''); v_secret text := nullif(trim(p_secret), '');
begin
  perform public.require_super_admin('Turnstile');
  if v_site is not null and v_site !~ '^[0-9]x[A-Za-z0-9_-]{10,}$' then raise exception 'That isn''t a Turnstile site key: it starts like 0x4AAA'; end if;
  if v_secret is not null and v_secret !~ '^[0-9]x[A-Za-z0-9_-]{10,}$' then raise exception 'That isn''t a Turnstile secret key: it starts like 0x4AAA'; end if;
  insert into public.integration_keys (org_id, turnstile_site_key, turnstile_secret)
  values (v_org, v_site, case when v_secret is not null then extensions.pgp_sym_encrypt(v_secret, public.payment_keys_key()) end)
  on conflict (org_id) do update set
    turnstile_site_key = coalesce(excluded.turnstile_site_key, integration_keys.turnstile_site_key),
    turnstile_secret = coalesce(excluded.turnstile_secret, integration_keys.turnstile_secret),
    updated_by = public.current_email(), updated_at = now();
  if not exists (select 1 from public.integration_keys where org_id = v_org and turnstile_site_key is not null and turnstile_secret is not null) then
    raise exception 'Enter both the site key and the secret key';
  end if;
  perform public.write_activity(v_org, 'integration_keys_changed', 'integration_keys', v_org::text, null,
    jsonb_build_object('service', 'turnstile', 'site_key_changed', v_site is not null, 'secret_changed', v_secret is not null));
end $$;

-- Back to the platform's keys for one service: 'sendgrid', 'twilio' or 'turnstile'.
create or replace function public.clear_integration_keys(p_service text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  if p_service not in ('sendgrid','twilio','turnstile') then raise exception 'Unknown service %', p_service; end if;
  perform public.require_super_admin(initcap(p_service));
  update public.integration_keys set
    sendgrid_key = case when p_service = 'sendgrid' then null else sendgrid_key end,
    sendgrid_webhook_key = case when p_service = 'sendgrid' then null else sendgrid_webhook_key end,
    twilio_sid = case when p_service = 'twilio' then null else twilio_sid end,
    twilio_token = case when p_service = 'twilio' then null else twilio_token end,
    turnstile_site_key = case when p_service = 'turnstile' then null else turnstile_site_key end,
    turnstile_secret = case when p_service = 'turnstile' then null else turnstile_secret end,
    updated_by = public.current_email(), updated_at = now()
  where org_id = v_org;
  perform public.write_activity(v_org, 'integration_keys_cleared', 'integration_keys', v_org::text, null, jsonb_build_object('service', p_service));
end $$;

-- What the settings screens show (admins): which keys are the organization's own. Never the secrets.
create or replace function public.integration_keys_status()
returns table (sendgrid_key_set boolean, sendgrid_webhook_key_set boolean, twilio_sid text, twilio_token_set boolean,
               turnstile_site_key text, turnstile_secret_set boolean, updated_at timestamptz, updated_by text)
language sql stable security definer set search_path = '' as $$
  select k.sendgrid_key is not null, k.sendgrid_webhook_key is not null,
         case when k.twilio_sid is not null then 'AC…' || right(k.twilio_sid, 4) end, k.twilio_token is not null,
         k.turnstile_site_key, k.turnstile_secret is not null, k.updated_at, k.updated_by
  from public.integration_keys k
  where k.org_id = public.current_org_id() and public.is_admin()
$$;

-- ---------------------------------------------------------------------------
-- For the Edge Functions (service role only)
-- ---------------------------------------------------------------------------
create or replace function public.org_messaging_keys(p_org uuid)
returns table (sendgrid_key text, sendgrid_webhook_key text, twilio_sid text, twilio_token text)
language sql stable security definer set search_path = '' as $$
  select extensions.pgp_sym_decrypt(k.sendgrid_key, public.payment_keys_key()), k.sendgrid_webhook_key,
         case when k.twilio_token is not null then k.twilio_sid end,
         extensions.pgp_sym_decrypt(k.twilio_token, public.payment_keys_key())
  from public.integration_keys k where k.org_id = p_org
$$;

create or replace function public.org_turnstile_secret(p_org uuid) returns text
language sql stable security definer set search_path = '' as $$
  select extensions.pgp_sym_decrypt(k.turnstile_secret, public.payment_keys_key())
  from public.integration_keys k where k.org_id = p_org and k.turnstile_site_key is not null
$$;

-- A delivery report signed with one organization's own keys: it may only touch that organization's messages.
create or replace function public.message_event_scoped(p_scope uuid, p_id uuid, p_provider_id text, p_event text, p_reason text, p_at timestamptz)
returns void
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if p_id is not null then select id into v_id from public.messages where org_id = p_scope and id = p_id; end if;
  if v_id is null and p_provider_id is not null then
    select id into v_id from public.messages
    where org_id = p_scope and (provider_id = p_provider_id or (channel = 'email' and p_provider_id like provider_id || '.%')) limit 1;
  end if;
  if v_id is null then return; end if;
  perform public.message_event(p_scope, v_id, p_provider_id, p_event, p_reason, p_at);
end $$;

create or replace function public.sms_inbound_scoped(p_scope uuid, p_to text, p_from text, p_body text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.messaging_settings where org_id = p_scope and sms_from = public.normalize_phone(p_to)) then return; end if;
  perform public.sms_inbound(p_to, p_from, p_body);
end $$;

-- ---------------------------------------------------------------------------
-- The public payment page gets the organization's own Turnstile site key, when it has one
-- ---------------------------------------------------------------------------
create or replace function public.public_give_page(p_org uuid, p_campaign text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v jsonb := public.give_page_core(p_org, p_campaign); s public.payment_settings; v_site text;
begin
  if v is null then return null; end if;
  select * into s from public.payment_settings where org_id = p_org;
  select k.turnstile_site_key into v_site from public.integration_keys k where k.org_id = p_org and k.turnstile_secret is not null;
  return jsonb_set(v, '{payments}', (v -> 'payments') || jsonb_build_object(
    'ach', coalesce(s.ach_enabled, false),
    'daf', to_jsonb(coalesce(s.daf_programs, '{}')),
    'ach_authorization', case when s.ach_enabled then public.ach_authorization_text(p_org) end,
    'turnstile_site_key', v_site));
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'org_messaging_keys(uuid)', 'org_turnstile_secret(uuid)',
    'message_event_scoped(uuid, uuid, text, text, text, timestamptz)', 'sms_inbound_scoped(uuid, text, text, text)', 'require_super_admin(text)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
  foreach f in array array[
    'org_messaging_keys(uuid)', 'org_turnstile_secret(uuid)',
    'message_event_scoped(uuid, uuid, text, text, text, timestamptz)', 'sms_inbound_scoped(uuid, text, text, text)'
  ] loop
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
  foreach f in array array[
    'save_email_keys(text, text)', 'save_sms_keys(text, text)', 'save_turnstile_keys(text, text)',
    'clear_integration_keys(text)', 'integration_keys_status()'
  ] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
