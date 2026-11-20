-- Phase 9, Donary part: Donary Enterprise (https://developers.donary.com/docs/enterprise/).
--
-- Out: donors, collectors and campaigns go to Donary's devices through its Save APIs whenever they're added or
--      changed. Sub-campaigns go as Donary "reasons" under their parent campaign. Changes wait in an outbox that the
--      donary-sync function sends every 5 minutes, retrying with back-off. Donary has no delete call, so deleted
--      records simply stop being sent. Our IDs are used as Donary's (it creates a record with an ID it doesn't know).
-- In:  Donary posts charges, voids, pledges and schedules to the donary-webhook function. Donary doesn't sign them
--      and they must be reachable without a login, so each organization's address carries its own long random token.
--      Each event is kept once (Donary retries up to three times); a charge becomes a donation, a void voids it, a
--      pledge becomes a pledge. Anything that can't be matched (unknown campaign, other currency) is kept for an
--      admin to fix and run again.
-- Nothing is sent or accepted until the Super Admin turns it on with the organization's Donary orgGuid and API key.

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------
create table public.donary_settings (
  org_id         uuid primary key references public.organizations(id) on delete cascade,
  enabled        boolean not null default false,
  org_guid       text check (org_guid ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  api_key        bytea,
  webhook_token  text not null unique default encode(extensions.gen_random_bytes(24), 'hex'),
  updated_by     text default public.current_email(),
  updated_at     timestamptz not null default now()
);
alter table public.donary_settings enable row level security;
revoke all on public.donary_settings from public, anon, authenticated;

create or replace function public.donary_on(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select s.enabled and s.org_guid is not null and s.api_key is not null from public.donary_settings s where s.org_id = p_org), false)
$$;

create or replace function public.save_donary_settings(p_enabled boolean, p_org_guid text, p_api_key text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_guid text := nullif(trim(p_org_guid), ''); v_key text := nullif(trim(p_api_key), '');
begin
  perform public.require_org_super_admin('change the Donary connection');
  if v_guid is not null and v_guid !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'The orgGuid looks like 115e9d3d-baf2-4089-b896-9b2621ffcf1b';
  end if;
  insert into public.donary_settings (org_id, enabled, org_guid, api_key)
  values (v_org, coalesce(p_enabled, false), lower(v_guid), case when v_key is not null then extensions.pgp_sym_encrypt(v_key, public.payment_keys_key()) end)
  on conflict (org_id) do update set
    enabled = excluded.enabled, org_guid = coalesce(excluded.org_guid, donary_settings.org_guid),
    api_key = coalesce(excluded.api_key, donary_settings.api_key), updated_by = public.current_email(), updated_at = now();
  if p_enabled and not public.donary_on(v_org) then raise exception 'Enter the orgGuid and API key Donary gave you before turning it on'; end if;
  perform public.write_activity(v_org, 'donary_settings_changed', 'donary_settings', v_org::text, null,
    jsonb_build_object('enabled', coalesce(p_enabled, false), 'org_guid_changed', v_guid is not null, 'api_key_changed', v_key is not null));
end $$;

-- A new webhook token, if the old one may have leaked. Donary has to be told the new addresses.
create or replace function public.rotate_donary_webhook_token() returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  perform public.require_org_super_admin('change the Donary webhook addresses');
  insert into public.donary_settings (org_id) values (v_org) on conflict (org_id) do update set
    webhook_token = encode(extensions.gen_random_bytes(24), 'hex'), updated_by = public.current_email(), updated_at = now();
  perform public.write_activity(v_org, 'donary_webhook_rotated', 'donary_settings', v_org::text, null, '{}'::jsonb);
end $$;

-- ---------------------------------------------------------------------------
-- Out: the outbox
-- ---------------------------------------------------------------------------
create table public.donary_outbox (
  id          bigint generated always as identity primary key,
  org_id      uuid not null references public.organizations(id) on delete cascade,
  kind        text not null check (kind in ('campaign','reason','collector','donor')),
  ref_id      text not null,
  queued_at   timestamptz not null default now(),
  attempts    int not null default 0,
  next_try    timestamptz not null default now(),
  last_error  text,
  sent_at     timestamptz,
  given_up    boolean not null default false
);
create unique index donary_outbox_waiting on public.donary_outbox (org_id, kind, ref_id) where sent_at is null and not given_up;
create index on public.donary_outbox (next_try) where sent_at is null and not given_up;
alter table public.donary_outbox enable row level security;
revoke all on public.donary_outbox from public, anon, authenticated;

create or replace function public.donary_enqueue(p_org uuid, p_kind text, p_ref text) returns void
language sql security definer set search_path = '' as $$
  insert into public.donary_outbox (org_id, kind, ref_id) select p_org, p_kind, p_ref where public.donary_on(p_org)
  on conflict (org_id, kind, ref_id) where sent_at is null and not given_up
  do update set next_try = least(donary_outbox.next_try, now()), queued_at = now()
$$;

create or replace function public.donary_track() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.deleted_at is not null then return null; end if;
  if tg_table_name = 'donors' then
    if tg_op = 'UPDATE' and row(old.english_title, old.first_name, old.last_name, old.yiddish_title, old.yiddish_first_name,
         old.yiddish_last_name, old.yiddish_suffix, old.phone, old.email, old.address)
       is not distinct from row(new.english_title, new.first_name, new.last_name, new.yiddish_title, new.yiddish_first_name,
         new.yiddish_last_name, new.yiddish_suffix, new.phone, new.email, new.address) then return null; end if;
    perform public.donary_enqueue(new.org_id, 'donor', new.id);
  elsif tg_table_name = 'collectors' then
    if tg_op = 'UPDATE' and row(old.first_name, old.last_name, old.phone, old.email) is not distinct from row(new.first_name, new.last_name, new.phone, new.email) then return null; end if;
    perform public.donary_enqueue(new.org_id, 'collector', new.id);
  else
    if tg_op = 'UPDATE' and row(old.internal_name, old.external_name, old.campaign_name, old.parent_campaign_id)
       is not distinct from row(new.internal_name, new.external_name, new.campaign_name, new.parent_campaign_id) then return null; end if;
    perform public.donary_enqueue(new.org_id, case when new.parent_campaign_id is null then 'campaign' else 'reason' end, new.id);
  end if;
  return null;
end $$;
create trigger donary_track after insert or update on public.donors for each row execute function public.donary_track();
create trigger donary_track after insert or update on public.collectors for each row execute function public.donary_track();
create trigger donary_track after insert or update on public.campaigns for each row execute function public.donary_track();

-- Everything, for the first sync (Donary's portal import is the other way in).
create or replace function public.donary_queue_all() returns int
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_n int := 0;
begin
  perform public.require_org_super_admin('send everything to Donary');
  if not public.donary_on(v_org) then raise exception 'Turn the Donary connection on first'; end if;
  perform public.donary_enqueue(v_org, case when c.parent_campaign_id is null then 'campaign' else 'reason' end, c.id)
  from public.campaigns c where c.org_id = v_org and c.deleted_at is null;
  get diagnostics v_n = row_count;
  perform public.donary_enqueue(v_org, 'collector', x.id) from public.collectors x where x.org_id = v_org and x.deleted_at is null;
  perform public.donary_enqueue(v_org, 'donor', d.id) from public.donors d where d.org_id = v_org and d.deleted_at is null and d.merged_into is null;
  return (select count(*) from public.donary_outbox o where o.org_id = v_org and o.sent_at is null and not o.given_up);
end $$;

-- Donary wants 10 digits for US phones.
create or replace function public.donary_phone(p text) returns text
language sql immutable as $$
  select case when n like '+1%' and length(n) = 12 then substr(n, 3) else ltrim(n, '+') end
  from (select public.normalize_phone(p) n) s where s.n is not null
$$;

-- Our country codes in Donary's words: the country name for addresses, a three-letter code for phones.
create or replace function public.donary_country(p text, p_phone boolean) returns text
language sql immutable as $$
  select case coalesce(p, 'US')
    when 'US' then case when p_phone then 'USA' else 'United States' end
    when 'CA' then case when p_phone then 'CAN' else 'Canada' end
    when 'IL' then case when p_phone then 'ISR' else 'Israel' end
    when 'GB' then case when p_phone then 'GBR' else 'United Kingdom' end
    else p end
$$;

-- What goes to Donary for one record. Raises when the record can't be sent.
-- Null fields leave Donary's value alone; phones, emails and addresses are sent only when we have one, under the
-- label "Main", because Donary deletes any labelled entry missing from a list it is sent.
create or replace function public.donary_payload(p_org uuid, p_kind text, p_ref text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_guid text := (select org_guid from public.donary_settings where org_id = p_org); d record; c record; v_num bigint;
begin
  if p_kind = 'donor' then
    select * into d from public.donors x where x.org_id = p_org and x.id = p_ref and x.deleted_at is null;
    if d.id is null then raise exception 'Donor % is gone', p_ref; end if;
    if (nullif(trim(d.first_name), '') is null or nullif(trim(d.last_name), '') is null)
       and (nullif(trim(d.yiddish_first_name), '') is null or nullif(trim(d.yiddish_last_name), '') is null) then
      raise exception 'Donary needs a first and last name, in English or Hebrew';
    end if;
    return jsonb_strip_nulls(jsonb_build_object(
      'orgGuid', v_guid, 'donorId', d.id, 'title', nullif(d.english_title, ''), 'firstName', nullif(d.first_name, ''),
      'lastName', nullif(d.last_name, ''), 'titleHebrew', nullif(d.yiddish_title, ''), 'firstNameHebrew', nullif(d.yiddish_first_name, ''),
      'lastNameHebrew', nullif(d.yiddish_last_name, ''), 'suffixHebrew', nullif(d.yiddish_suffix, ''),
      'donorPhones', case when public.donary_phone(d.phone) is not null then jsonb_build_array(jsonb_build_object('phoneLabel', 'Main', 'phoneNumber', public.donary_phone(d.phone), 'countryCode', public.donary_country(d.country, true))) end,
      'donorEmails', case when nullif(trim(d.email), '') is not null then jsonb_build_array(jsonb_build_object('emailLabel', 'Main', 'emailAddress', trim(d.email))) end,
      'donorAddresses', case when nullif(trim(d.address), '') is not null then jsonb_build_array(jsonb_build_object('addressLabel', 'Main', 'streetName', trim(d.address), 'country', public.donary_country(d.country, false))) end));
  elsif p_kind = 'collector' then
    select * into c from public.collectors x where x.org_id = p_org and x.id = p_ref and x.deleted_at is null;
    if c.id is null then raise exception 'Collector % is gone', p_ref; end if;
    if nullif(trim(c.first_name), '') is null or nullif(trim(c.last_name), '') is null then raise exception 'Donary needs the collector''s first and last name'; end if;
    return jsonb_strip_nulls(jsonb_build_object(
      'orgGuid', v_guid, 'collectorId', c.id, 'firstName', trim(c.first_name), 'lastName', trim(c.last_name),
      'collectorPhones', case when public.donary_phone(c.phone) is not null then jsonb_build_array(jsonb_build_object('phoneLabel', 'Main', 'phoneNumber', public.donary_phone(c.phone), 'countryCode', 'USA')) end,
      'collectorEmails', case when nullif(trim(c.email), '') is not null then jsonb_build_array(jsonb_build_object('emailLabel', 'Main', 'emailAddress', trim(c.email))) end));
  else
    select * into c from public.campaigns x where x.org_id = p_org and x.id = p_ref and x.deleted_at is null;
    if c.id is null then raise exception 'Campaign % is gone', p_ref; end if;
    if c.id !~ '^\d{1,9}$' then raise exception 'Donary numbers campaigns; % isn''t a number', c.id; end if;
    v_num := c.id::bigint;
    if p_kind = 'campaign' then
      return jsonb_build_object('orgGuid', v_guid, 'campaignNumber', v_num,
        'campaignName', coalesce(nullif(c.internal_name, ''), nullif(c.campaign_name, ''), nullif(c.external_name, ''), c.id),
        'campaignFriendlyName', coalesce(nullif(c.external_name, ''), nullif(c.internal_name, ''), nullif(c.campaign_name, ''), c.id));
    end if;
    if c.parent_campaign_id !~ '^\d{1,9}$' then raise exception 'The parent campaign % isn''t a number', c.parent_campaign_id; end if;
    return jsonb_build_object('orgGuid', v_guid, 'reasonNumber', v_num,
      'reasonName', coalesce(nullif(c.external_name, ''), nullif(c.internal_name, ''), nullif(c.campaign_name, ''), c.id),
      'campaignNum', c.parent_campaign_id::bigint);
  end if;
end $$;

-- For donary-sync (service role): up to p_limit records due, campaigns before reasons (a reason needs its campaign),
-- with what to send and where. Claimed items move their next try forward so two runs can't send them twice.
create or replace function public.donary_claim(p_limit int default 50)
returns table (id bigint, org_id uuid, kind text, ref_id text, payload jsonb, api_key text, error text)
language plpgsql security definer set search_path = '' as $$
declare o public.donary_outbox; v_payload jsonb; v_error text;
begin
  for o in
    select * from public.donary_outbox x
    where x.sent_at is null and not x.given_up and x.next_try <= now() and public.donary_on(x.org_id)
    order by array_position(array['campaign','reason','collector','donor'], x.kind), x.queued_at
    limit p_limit for update skip locked
  loop
    v_payload := null; v_error := null;
    begin
      v_payload := public.donary_payload(o.org_id, o.kind, o.ref_id);
    exception when others then
      v_error := sqlerrm;
    end;
    update public.donary_outbox x set attempts = x.attempts + 1, next_try = now() + interval '10 minutes' where x.id = o.id;
    if v_error is not null then
      perform public.donary_sent(o.id, false, v_error);
      continue;
    end if;
    return query select o.id, o.org_id, o.kind, o.ref_id, v_payload,
      (select extensions.pgp_sym_decrypt(s.api_key, public.payment_keys_key()) from public.donary_settings s where s.org_id = o.org_id), null::text;
  end loop;
end $$;

-- Donary's answer for one item. Failures wait 5 minutes, doubling up to 6 hours, and stop after 8 tries;
-- a record that can't be sent as it is (no name, not a number) stops at once.
create or replace function public.donary_sent(p_id bigint, p_ok boolean, p_error text) returns void
language sql security definer set search_path = '' as $$
  update public.donary_outbox set
    sent_at = case when p_ok then now() end,
    last_error = case when p_ok then null else left(p_error, 500) end,
    next_try = case when p_ok then next_try else now() + least(interval '6 hours', interval '5 minutes' * power(2, greatest(attempts - 1, 0))) end,
    given_up = not p_ok and (attempts >= 8 or p_error ~ '^(Donary needs|Donary numbers|The parent campaign|Donor .* is gone|Collector .* is gone|Campaign .* is gone)')
  where id = p_id
$$;

create or replace function public.kick_donary_sync() returns void
language plpgsql security definer set search_path = '' as $$
declare v_url text; v_token text;
begin
  if not exists (select 1 from public.donary_outbox x where x.sent_at is null and not x.given_up and x.next_try <= now()) then return; end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into v_token from vault.decrypted_secrets where name = 'messaging_cron_token';
  if v_url is null or v_token is null then return; end if;
  perform net.http_post(url := rtrim(v_url, '/') || '/functions/v1/donary-sync',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-token', v_token), body := '{}'::jsonb);
end $$;
select cron.schedule('donary_sync', '*/5 * * * *', $$select public.kick_donary_sync()$$);

-- ---------------------------------------------------------------------------
-- In: webhooks
-- ---------------------------------------------------------------------------
create table public.donary_events (
  id           bigint generated always as identity primary key,
  org_id       uuid not null references public.organizations(id) on delete cascade,
  event        text not null check (event in ('charge','void','pledge','schedule')),
  event_key    text not null,
  payload      jsonb not null,
  received_at  timestamptz not null default now(),
  status       text not null check (status in ('recorded','unmatched','ignored')),
  detail       text,
  donation_id  text,
  pledge_id    text,
  unique (org_id, event, event_key)
);
create index on public.donary_events (org_id, received_at desc);
alter table public.donary_events enable row level security;
revoke all on public.donary_events from public, anon, authenticated;

-- Donary's examples mix camelCase and PascalCase, and send some parts as an object or a one-item list.
create or replace function public.dj(p jsonb, variadic p_keys text[]) returns text
language sql immutable as $$
  select coalesce(
    (select v #>> '{}' from jsonb_each(case when jsonb_typeof(p) = 'object' then p else '{}'::jsonb end) e(k, v)
     where lower(k) = any (select lower(x) from unnest(p_keys) x) and jsonb_typeof(v) not in ('null') limit 1), null)
$$;
create or replace function public.dobj(p jsonb, p_key text) returns jsonb
language sql immutable as $$
  select case jsonb_typeof(v) when 'array' then v->0 when 'object' then v end
  from (select (select e.v from jsonb_each(case when jsonb_typeof(p) = 'object' then p else '{}'::jsonb end) e(k, v) where lower(e.k) = lower(p_key) limit 1) v) s
$$;

-- Our campaign for a Donary event: the reason's sub-campaign when it is one, else the campaign.
create or replace function public.donary_campaign(p_org uuid, p jsonb) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select c.id from public.campaigns c where c.org_id = p_org and c.deleted_at is null and c.parent_campaign_id is not null
       and c.id = public.dj(public.dobj(p, 'reasonInfo'), 'reasonNumber')),
    (select c.id from public.campaigns c where c.org_id = p_org and c.deleted_at is null
       and c.id = public.dj(public.dobj(p, 'campaignInfo'), 'campaignNumber')))
$$;

-- Our donor: one we sent (donorNumber is our ID), or the new donor made on the device, added here with Donary's ID.
create or replace function public.donary_donor(p_org uuid, p jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare v_info jsonb := public.dobj(p, 'donorInfo'); v_new jsonb := public.dobj(v_info, 'newDonor'); v_id text;
begin
  v_id := public.dj(v_info, 'donorNumber');
  if v_id is not null and exists (select 1 from public.donors d where d.org_id = p_org and d.id = v_id) then return v_id; end if;
  v_id := coalesce(public.dj(v_new, 'donorID', 'donorId'), v_id);
  if v_id is null then return null; end if;
  if not exists (select 1 from public.donors d where d.org_id = p_org and d.id = v_id) then
    if public.dj(v_new, 'firstName') is null and public.dj(v_new, 'lastName') is null then return null; end if;
    insert into public.donors (org_id, id, first_name, last_name, notes, created_by)
    values (p_org, v_id, public.dj(v_new, 'firstName'), public.dj(v_new, 'lastName'), 'Added on a Donary device', 'Donary');
  end if;
  return v_id;
end $$;

-- Donary's times are UTC with no zone written ("2024-11-25T21:01:14.44" or "2024-06-25 00:00:00").
create or replace function public.donary_time(p text) returns timestamptz
language plpgsql immutable as $$
begin
  if p is null then return null; end if;
  return case when p ~ '(Z|[+-]\d\d:?\d\d)$' then p::timestamptz else (p || 'Z')::timestamptz end;
exception when others then
  raise exception 'unmatched: unreadable date %', p;
end $$;

create or replace function public.donary_amount(p text) returns numeric
language sql immutable as $$ select case when p ~ '^-?\d+(\.\d+)?$' then round(p::numeric, 2) end $$;

-- One charge (or a schedule's first payment). Returns the donation's ID, or raises with why it can't be matched.
create or replace function public.donary_record_charge(p_org uuid, p jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_campaign text := public.donary_campaign(p_org, p);
  v_amount numeric := public.donary_amount(public.dj(p, 'amount'));
  v_number text := public.dj(p, 'paymentNumber');
  v_device text := public.dj(p, 'deviceName');
  v_method text := replace(coalesce(public.dj(p, 'paymentMethod'), 'Credit Card'), '_', ' ');
  v_existing text;
  v_id text;
begin
  if coalesce(upper(public.dj(p, 'currency')), 'USD') <> 'USD' then raise exception 'unmatched: paid in %, not dollars', public.dj(p, 'currency'); end if;
  if v_amount is null or v_amount <= 0 then raise exception 'unmatched: no amount'; end if;
  if v_campaign is null then
    raise exception 'unmatched: no campaign % here', coalesce(public.dj(public.dobj(p, 'campaignInfo'), 'campaignNumber'), '(none given)');
  end if;
  select d.id into v_existing from public.donations d where d.org_id = p_org and d.donary_id = v_number and d.deleted_at is null limit 1;
  if v_existing is not null then return v_existing; end if;
  perform set_config('request.headers', jsonb_build_object('x-org-id', p_org)::text, true);
  insert into public.donations (org_id, campaign_id, donor_id, amount, type, status, payment_method, source, donary_id, gateway_id,
                                name, anonymous, notes, created_at, created_by)
  values (p_org, v_campaign, public.donary_donor(p_org, p), v_amount, 'Payment',
          case when coalesce(public.dj(p, 'paymentStatus'), 'Success') ilike 'success' then 'completed' else 'failed' end,
          case when v_method ilike 'credit card' then 'Credit Card' else v_method end,
          (select m.source_id from public.machines m where m.org_id = p_org and lower(m.donary_id) = lower(v_device) and m.source_id is not null),
          v_number, public.dj(p, 'gatewayRefNum'), nullif(public.dj(p, 'cardHolderName'), ''),
          coalesce(public.dj(p, 'isAnonymousDonation') = 'true', false),
          concat_ws(' · ', 'Donary', v_device, nullif(concat_ws(' ', public.dj(p, 'brand'), public.dj(p, 'last4Digits')), '')),
          coalesce(public.donary_time(public.dj(p, 'processedDateTime')), now()), 'Donary')
  returning id into v_id;
  return v_id;
end $$;

-- Everything an event does. Returns {status, detail, donation_id?, pledge_id?}.
create or replace function public.donary_apply(p_org uuid, p_event text, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_id text; v_campaign text; v_amount numeric; v_status text;
begin
  if p_event = 'charge' then
    v_id := public.donary_record_charge(p_org, p);
    return jsonb_build_object('status', 'recorded', 'donation_id', v_id);
  elsif p_event = 'void' then
    v_status := public.dj(p, 'paymentStatus');
    if coalesce(v_status, '') not ilike 'voided' then
      return jsonb_build_object('status', 'ignored', 'detail', 'Status ' || coalesce(v_status, '(none)') || ' needs no change');
    end if;
    select d.id into v_id from public.donations d where d.org_id = p_org and d.donary_id = public.dj(p, 'paymentNumber') and d.deleted_at is null limit 1;
    if v_id is null then raise exception 'unmatched: no donation with Donary payment %', public.dj(p, 'paymentNumber'); end if;
    perform set_config('request.headers', jsonb_build_object('x-org-id', p_org)::text, true);
    update public.donations set status = 'voided', reversal_reason = 'Voided at Donary',
      reversal_date = coalesce((public.donary_time(public.dj(p, 'statusDateTime')) at time zone 'UTC')::date, current_date)
    where org_id = p_org and id = v_id and status <> 'voided';
    return jsonb_build_object('status', 'recorded', 'donation_id', v_id);
  elsif p_event = 'pledge' then
    v_campaign := public.donary_campaign(p_org, p);
    v_amount := public.donary_amount(public.dj(p, 'pledgeAmount'));
    if coalesce(upper(public.dj(p, 'currency')), 'USD') <> 'USD' then raise exception 'unmatched: pledged in %, not dollars', public.dj(p, 'currency'); end if;
    if v_campaign is null then raise exception 'unmatched: no campaign % here', coalesce(public.dj(public.dobj(p, 'campaignInfo'), 'campaignNumber'), '(none given)'); end if;
    if v_amount is null or v_amount <= 0 then raise exception 'unmatched: no amount'; end if;
    select x.id into v_id from public.pledges x where x.org_id = p_org and x.donary_id = public.dj(p, 'pledgeNumber') and x.deleted_at is null;
    if v_id is null then
      perform set_config('request.headers', jsonb_build_object('x-org-id', p_org)::text, true);
      insert into public.pledges (org_id, campaign_id, donor_id, amount, donary_id, reference, source, date_pledged, created_by)
      values (p_org, v_campaign, public.donary_donor(p_org, p), v_amount, public.dj(p, 'pledgeNumber'), 'Donary pledge ' || public.dj(p, 'pledgeNumber'),
              'Donary', coalesce(left(public.dj(p, 'deviceCreatedDate'), 10)::date, current_date), 'Donary')
      returning id into v_id;
    end if;
    return jsonb_build_object('status', 'recorded', 'pledge_id', v_id);
  else
    -- A schedule: Donary runs it (recommended setting), so only a first payment taken today becomes a donation.
    if public.dobj(p, 'firstPayment') is not null then
      v_id := public.donary_record_charge(p_org, public.dobj(p, 'firstPayment')
        || jsonb_build_object('donorInfo', public.dobj(p, 'donorInfo'), 'campaignInfo', public.dobj(p, 'campaignInfo'),
                              'reasonInfo', public.dobj(p, 'reasonInfo'), 'currency', public.dj(p, 'currency')));
      return jsonb_build_object('status', 'recorded', 'donation_id', v_id,
        'detail', format('%s × %s %s; first payment recorded', public.dj(p, 'countOfSchedules'), public.dj(p, 'frequency'), public.dj(p, 'totalScheduleAmount')));
    end if;
    return jsonb_build_object('status', 'recorded',
      'detail', format('%s × %s from %s, %s in all', public.dj(p, 'countOfSchedules'), public.dj(p, 'frequency'), public.dj(p, 'scheduleStartDate'), public.dj(p, 'totalScheduleAmount')));
  end if;
exception when others then
  -- Kept for an admin either way; Donary isn't asked to send it again.
  return jsonb_build_object('status', 'unmatched', 'detail', case when sqlerrm like 'unmatched: %' then substr(sqlerrm, 12) else sqlerrm end);
end $$;

-- For donary-webhook (service role). Unknown token: null (the function answers 401).
create or replace function public.donary_ingest(p_token text, p_event text, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
  v_key text;
  v_res jsonb;
  v_id bigint;
begin
  select s.org_id into v_org from public.donary_settings s where s.webhook_token = p_token and s.enabled;
  if v_org is null or p_token is null or length(p_token) < 32 then return null; end if;
  if p_event not in ('charge','void','pledge','schedule') then return jsonb_build_object('status', 'ignored', 'detail', 'Unknown event'); end if;
  v_key := case p_event
    when 'charge' then public.dj(p_payload, 'paymentNumber')
    when 'void' then public.dj(p_payload, 'paymentNumber') || ':' || coalesce(public.dj(p_payload, 'paymentStatus'), '')
    when 'pledge' then public.dj(p_payload, 'pledgeNumber')
    else public.dj(p_payload, 'scheduleUniqueID') end;
  if v_key is null then v_key := 'sha256:' || encode(extensions.digest(p_payload::text, 'sha256'), 'hex'); end if;
  if exists (select 1 from public.donary_events e where e.org_id = v_org and e.event = p_event and e.event_key = v_key) then
    return jsonb_build_object('status', 'duplicate');
  end if;
  v_res := public.donary_apply(v_org, p_event, p_payload);
  insert into public.donary_events (org_id, event, event_key, payload, status, detail, donation_id, pledge_id)
  values (v_org, p_event, v_key, p_payload, v_res->>'status', v_res->>'detail', v_res->>'donation_id', v_res->>'pledge_id')
  returning id into v_id;
  return v_res || jsonb_build_object('event_id', v_id);
end $$;

-- An admin runs an unmatched event again after fixing what was missing (such as adding the campaign).
create or replace function public.donary_retry_event(p_id bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare e public.donary_events; v_res jsonb;
begin
  if not public.is_admin() then raise exception 'Only admins can run Donary events again'; end if;
  select * into e from public.donary_events x where x.id = p_id and x.org_id = public.current_org_id();
  if e.id is null then raise exception 'No such Donary event'; end if;
  if e.status <> 'unmatched' then raise exception 'Only unmatched events can run again'; end if;
  v_res := public.donary_apply(e.org_id, e.event, e.payload);
  update public.donary_events set status = v_res->>'status', detail = v_res->>'detail', donation_id = v_res->>'donation_id', pledge_id = v_res->>'pledge_id'
  where id = e.id;
  perform public.write_activity(e.org_id, 'donary_event_retried', 'donary_events', e.id::text, null, v_res);
  return v_res;
end $$;

-- ---------------------------------------------------------------------------
-- What the settings screen shows (admins; the webhook token only to the Super Admin)
-- ---------------------------------------------------------------------------
create or replace function public.donary_status() returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when public.is_admin() then jsonb_build_object(
    'enabled', coalesce(s.enabled, false), 'org_guid', s.org_guid, 'api_key_set', s.api_key is not null,
    'webhook_token', case when public.is_super_admin() then s.webhook_token end,
    'updated_by', s.updated_by, 'updated_at', s.updated_at,
    'waiting', (select count(*) from public.donary_outbox o where o.org_id = o2.id and o.sent_at is null and not o.given_up),
    'stuck', (select count(*) from public.donary_outbox o where o.org_id = o2.id and o.given_up),
    'last_sent', (select max(o.sent_at) from public.donary_outbox o where o.org_id = o2.id),
    'problems', (select coalesce(jsonb_agg(jsonb_build_object('kind', o.kind, 'ref_id', o.ref_id, 'error', o.last_error, 'attempts', o.attempts, 'given_up', o.given_up) order by o.queued_at desc), '[]')
                 from (select * from public.donary_outbox o where o.org_id = o2.id and o.last_error is not null and o.sent_at is null order by o.queued_at desc limit 20) o),
    'events', (select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'event', e.event, 'event_key', e.event_key, 'status', e.status, 'detail', e.detail,
                 'donation_id', e.donation_id, 'pledge_id', e.pledge_id, 'received_at', e.received_at) order by e.received_at desc), '[]')
               from (select * from public.donary_events e where e.org_id = o2.id order by e.received_at desc limit 50) e))
  end
  from (select public.current_org_id() id) o2 left join public.donary_settings s on s.org_id = o2.id
$$;

-- ---------------------------------------------------------------------------
-- Who may call what
-- ---------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array['donary_on(uuid)', 'donary_enqueue(uuid, text, text)', 'donary_payload(uuid, text, text)', 'donary_claim(integer)',
    'donary_sent(bigint, boolean, text)', 'kick_donary_sync()', 'donary_campaign(uuid, jsonb)', 'donary_donor(uuid, jsonb)',
    'donary_record_charge(uuid, jsonb)', 'donary_apply(uuid, text, jsonb)', 'donary_ingest(text, text, jsonb)'] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
  foreach f in array array['donary_claim(integer)', 'donary_sent(bigint, boolean, text)', 'donary_ingest(text, text, jsonb)', 'donary_payload(uuid, text, text)'] loop
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
  foreach f in array array['save_donary_settings(boolean, text, text)', 'rotate_donary_webhook_token()', 'donary_queue_all()',
    'donary_retry_event(bigint)', 'donary_status()'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
  end loop;
end $$;
