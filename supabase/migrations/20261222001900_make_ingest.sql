-- Make ingest (Shulim, 2026-11-12): authenticated endpoints so Oizer's six live Make scenarios (Donary payment,
-- pledge, void and schedule; Sola; Elevon) can also send real transactions to Donor Base, for testing only.
--   * Per organization: its own secret (only a SHA-256 fingerprint is stored; shown once when generated), an on/off
--     switch, and the test batch every created row is registered under (test_import_rows), so the whole test can be
--     removed with delete_test_import(batch) before the real migration.
--   * Payment tokens (token, xToken, xKey, ...) and the raw body are never stored. Each call leaves one log line:
--     source, outcome, record id, a short message.
--   * Idempotent: a retry with the same Donary payment number, gateway reference or pledge number returns the
--     existing record instead of creating another.
--   * Campaign numbers match campaigns imported from AppSheet ('AS-' + number), then a campaign with that number.

create table if not exists public.make_ingest_settings (
  org_id      uuid primary key references public.organizations(id),
  enabled     boolean not null default false,
  secret_hash text,
  secret_hint text,
  batch_id    text not null default 'make-test-2026-11-12',
  updated_by  text,
  updated_at  timestamptz not null default now()
);
alter table public.make_ingest_settings enable row level security;
revoke all on public.make_ingest_settings from public, anon, authenticated;

create table if not exists public.make_ingest_log (
  id         bigint generated always as identity primary key,
  org_id     uuid not null references public.organizations(id),
  source     text not null,
  outcome    text not null,        -- created, duplicate, voided, updated, skipped, rejected, error
  record_id  text,
  message    text,
  created_at timestamptz not null default now()
);
create index if not exists make_ingest_log_org on public.make_ingest_log (org_id, created_at desc);
alter table public.make_ingest_log enable row level security;
revoke all on public.make_ingest_log from public, anon, authenticated;

-- The activity log keeps no history of rows a Make test ingest writes (they are removed with their batch).
create or replace function public.log_row_change() returns trigger
language plpgsql security definer set search_path = '' as $function$
declare
  v_old jsonb;
  v_new jsonb;
  v_row jsonb;
  v_changes jsonb;
  v_action text := lower(tg_op);
begin
  -- Rows a Make test ingest writes are test data removed with their batch; they leave no history behind.
  if current_setting('oizer.make_ingest', true) = 'on' then return null; end if;
  if tg_op <> 'INSERT' then v_old := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then v_new := to_jsonb(new); end if;
  v_row := coalesce(v_new, v_old);

  if tg_op = 'UPDATE' then
    select jsonb_object_agg(n.key, jsonb_build_object('old', o.value, 'new', n.value))
      into v_changes
      from jsonb_each(v_new) n
      join jsonb_each(v_old) o on o.key = n.key
     where n.value is distinct from o.value and n.key not in ('updated_at','last_login_at');
    if v_changes is null then return null; end if;
    if v_old ->> 'deleted_at' is null and v_new ->> 'deleted_at' is not null then
      v_action := 'soft_delete';
    elsif v_old ->> 'deleted_at' is not null and v_new ->> 'deleted_at' is null then
      v_action := 'restore';
    end if;
  else
    v_changes := jsonb_strip_nulls(v_row);
  end if;

  perform public.write_activity(
    coalesce((v_row ->> 'org_id')::uuid,
             case when tg_table_name = 'organizations' then (v_row ->> 'id')::uuid end,
             public.current_org_id()),
    v_action, tg_table_name,
    case when tg_table_name = 'org_members' then v_row ->> 'user_id'
         else coalesce(v_row ->> 'id', v_row ->> 'user_id', v_row ->> 'email', v_row ->> 'key') end,
    coalesce(v_row ->> 'campaign_id', v_row ->> 'from_campaign_id',
             case when tg_table_name = 'campaigns' then v_row ->> 'id' end),
    v_changes);
  return null;
end $function$;

-- ---------------------------------------------------------------- settings (admins of the organization)
create or replace function public.make_ingest_status()
returns table (enabled boolean, secret_set boolean, secret_hint text, batch_id text, updated_at timestamptz, events_24h bigint, last_event_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select coalesce(s.enabled, false), s.secret_hash is not null, s.secret_hint, coalesce(s.batch_id, 'make-test-2026-11-12'), s.updated_at,
         (select count(*) from public.make_ingest_log l where l.org_id = o.id and l.created_at > now() - interval '24 hours'),
         (select max(l.created_at) from public.make_ingest_log l where l.org_id = o.id)
  from (select public.current_org_id() id) o left join public.make_ingest_settings s on s.org_id = o.id
  where public.is_admin()
$$;

-- A new secret, returned once; only its fingerprint is kept. Super Admin only, like other keys.
create or replace function public.make_ingest_new_secret() returns text
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_secret text := 'dbk_' || encode(extensions.gen_random_bytes(24), 'hex');
begin
  if not public.is_super_admin() then raise exception 'Only the Super Admin can create the Make secret'; end if;
  insert into public.make_ingest_settings (org_id, secret_hash, secret_hint, updated_by)
  values (v_org, encode(extensions.digest(v_secret, 'sha256'), 'hex'), right(v_secret, 4), public.current_email())
  on conflict (org_id) do update set secret_hash = excluded.secret_hash, secret_hint = excluded.secret_hint, updated_by = excluded.updated_by, updated_at = now();
  perform public.write_activity(v_org, 'make_secret_rotated', 'make_ingest_settings', v_org::text, null, '{}'::jsonb);
  return v_secret;
end $$;

create or replace function public.make_ingest_set_enabled(p_enabled boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_batch text;
begin
  if not public.is_super_admin() then raise exception 'Only the Super Admin can switch Make ingest on or off'; end if;
  insert into public.make_ingest_settings (org_id, enabled, updated_by) values (v_org, coalesce(p_enabled, false), public.current_email())
  on conflict (org_id) do update set enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = now()
  returning batch_id into v_batch;
  insert into public.test_import_batches (batch_id, org_id, note)
  values (v_batch, v_org, 'Real transactions sent by Make for testing (Shulim); delete before the real migration')
  on conflict (batch_id) do nothing;
end $$;

-- ---------------------------------------------------------------- helpers
create or replace function public.make_num(p text) returns numeric
language sql immutable set search_path = '' as $$
  select case when regexp_replace(coalesce(p, ''), '[^0-9.\-]', '', 'g') ~ '^-?\d+(\.\d+)?$' then regexp_replace(p, '[^0-9.\-]', '', 'g')::numeric end
$$;

create or replace function public.make_time(p text) returns timestamptz
language plpgsql stable set search_path = '' as $$
begin
  return coalesce(nullif(trim(p), '')::timestamptz, now());
exception when others then
  return now();
end $$;

create or replace function public.make_first(p jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select case jsonb_typeof(p) when 'array' then p -> 0 else p end
$$;

create or replace function public.make_campaign(p_org uuid, p_number text) returns text
language sql stable security definer set search_path = '' as $$
  select c.id from public.campaigns c
  where c.org_id = p_org and c.deleted_at is null and c.status is distinct from 'closed' and nullif(trim(p_number), '') is not null
    and c.id in ('AS-' || trim(p_number), trim(p_number))
  order by (c.id = 'AS-' || trim(p_number)) desc limit 1
$$;

create or replace function public.make_source(p_org uuid, p_batch text, p_name text) returns text
language plpgsql security definer set search_path = '' as $$
declare v_id text; v_name text := nullif(trim(p_name), '');
begin
  if v_name is null then return null; end if;
  select s.id into v_id from public.sources s where s.org_id = p_org and s.deleted_at is null and lower(s.name) = lower(v_name) order by s.id limit 1;
  if v_id is not null then return v_id; end if;
  v_id := 'MK-SRC-' || left(trim(both '-' from regexp_replace(v_name, '\W+', '-', 'g')), 40);
  insert into public.sources (org_id, id, name) values (p_org, v_id, v_name) on conflict do nothing;
  if found then  -- only a source this ingest created is test data
    insert into public.test_import_rows (batch_id, table_name, record_id, source_sheet) values (p_batch, 'sources', v_id, 'make') on conflict do nothing;
  end if;
  return v_id;
end $$;

-- An existing donation for this payment, by Donary payment number or gateway reference.
create or replace function public.make_existing(p_org uuid, p_payment text, p_gateway text) returns text
language sql stable security definer set search_path = '' as $$
  select d.id from public.donations d
  where d.org_id = p_org and d.deleted_at is null
    and ((nullif(trim(p_payment), '') is not null and d.donary_id = trim(p_payment))
      or (nullif(trim(p_gateway), '') is not null and d.gateway_id = trim(p_gateway)))
  order by d.created_at limit 1
$$;

create or replace function public.make_new_donation(p_org uuid, p_batch text, p_source text, d jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare v_id text := 'MK-' || public.short_id();
begin
  insert into public.donations (org_id, id, campaign_id, amount, type, status, name, phone, email, source, payment_method, command, result,
                                gateway_id, donary_id, anonymous, collector_label, notes, created_at)
  values (p_org, v_id, d ->> 'campaign_id', (d ->> 'amount')::numeric, 'Payment', coalesce(d ->> 'status', 'completed'),
          nullif(trim(d ->> 'name'), ''), nullif(trim(d ->> 'phone'), ''), nullif(trim(d ->> 'email'), ''),
          public.make_source(p_org, p_batch, d ->> 'source'), nullif(trim(d ->> 'payment_method'), ''), nullif(trim(d ->> 'command'), ''),
          nullif(trim(d ->> 'result'), ''), nullif(trim(d ->> 'gateway_id'), ''), nullif(trim(d ->> 'donary_id'), ''),
          coalesce((d ->> 'anonymous')::boolean, false), nullif(trim(d ->> 'collector'), ''), nullif(trim(d ->> 'notes'), ''),
          public.make_time(d ->> 'created_at'));
  insert into public.test_import_rows (batch_id, table_name, record_id, source_sheet, source_id)
  values (p_batch, 'donations', v_id, 'make:' || p_source, coalesce(d ->> 'donary_id', d ->> 'gateway_id'));
  return v_id;
end $$;

create or replace function public.make_void(p_org uuid, p_payment text, p_gateway text, p_why text) returns text
language plpgsql security definer set search_path = '' as $$
declare v_id text := public.make_existing(p_org, p_payment, p_gateway);
begin
  if v_id is null then return null; end if;
  update public.donations set status = 'voided', reversal_date = current_date, reversal_reason = p_why
  where org_id = p_org and id = v_id and status <> 'voided';
  return v_id;
end $$;

create or replace function public.make_status(p text) returns text
language sql immutable set search_path = '' as $$
  select case
    when lower(coalesce(p, '')) in ('declined', 'failed', 'failure', 'error', 'rejected') then 'failed'
    when lower(coalesce(p, '')) in ('void', 'voided', 'cancelled', 'canceled') then 'voided'
    else 'completed' end
$$;

-- ---------------------------------------------------------------- the ingest (called by the make-ingest function)
create or replace function public.make_ingest(p_org uuid, p_key text, p_source text, p_body jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.make_ingest_settings;
  b jsonb := coalesce(p_body, '{}'::jsonb);
  di jsonb; fp jsonb;
  v_id text; v_existing text; v_name text; v_campaign text; v_amount numeric; v_out jsonb; v_cmd text;
begin
  select * into s from public.make_ingest_settings where org_id = p_org;
  if s.org_id is null or s.secret_hash is null or p_key is null
     or encode(extensions.digest(p_key, 'sha256'), 'hex') <> s.secret_hash then
    return jsonb_build_object('ok', false, 'status', 401, 'error', 'Not authorized');
  end if;
  if not s.enabled then
    return jsonb_build_object('ok', false, 'status', 403, 'error', 'Make ingest is switched off for this organization');
  end if;
  insert into public.test_import_batches (batch_id, org_id, note)
  values (s.batch_id, p_org, 'Real transactions sent by Make for testing (Shulim); delete before the real migration') on conflict (batch_id) do nothing;
  perform set_config('oizer.make_ingest', 'on', true);

  begin
    case p_source
    -- Donary payment, and a Donary schedule's first payment: a donation.
    when 'donary-payment', 'donary-schedule' then
      di := b -> 'donorInfo';
      fp := case when p_source = 'donary-schedule' then coalesce(b -> 'firstPayment', '{}'::jsonb) else b end;
      v_amount := public.make_num(fp ->> 'amount');
      if v_amount is null then raise exception 'No amount'; end if;
      v_existing := public.make_existing(p_org, fp ->> 'paymentNumber', fp ->> 'gatewayRefNum');
      if v_existing is not null then
        v_out := jsonb_build_object('outcome', 'duplicate', 'record_id', v_existing);
      else
        v_name := coalesce(nullif(trim(b ->> 'cardHolderName'), ''), nullif(trim(concat_ws(' ', di ->> 'firstName', di ->> 'lastName')), ''));
        v_id := public.make_new_donation(p_org, s.batch_id, p_source, jsonb_build_object(
          'campaign_id', public.make_campaign(p_org, public.make_first(b -> 'campaignInfo') ->> 'campaignNumber'),
          'amount', v_amount, 'status', public.make_status(coalesce(b ->> 'paymentStatus', fp ->> 'paymentStatus')),
          'name', v_name, 'phone', public.make_first(di -> 'donorPhones') ->> 'phoneNumber',
          'source', fp ->> 'deviceName', 'payment_method', fp ->> 'paymentMethod',
          'command', case when p_source = 'donary-schedule' then 'Donary Schedule' else 'Donary Payment' end,
          'result', coalesce(b ->> 'paymentStatus', fp ->> 'paymentStatus'), 'gateway_id', fp ->> 'gatewayRefNum', 'donary_id', fp ->> 'paymentNumber',
          'anonymous', coalesce((b ->> 'isAnonymousDonation')::boolean, false), 'collector', b -> 'collectorInfo' ->> 'collectorName',
          'notes', public.make_first(b -> 'reasonInfo') ->> 'reasonName',
          'created_at', coalesce(b ->> 'processedDateTime', fp ->> 'processedDateTime', b ->> 'deviceCreatedDate')));
        v_out := jsonb_build_object('outcome', 'created', 'record_id', v_id);
      end if;

    -- Donary pledge: a pledge.
    when 'donary-pledge' then
      di := b -> 'donorInfo';
      v_amount := public.make_num(b ->> 'pledgeAmount');
      if v_amount is null or v_amount <= 0 then raise exception 'No pledge amount'; end if;
      select p.id into v_existing from public.pledges p
      where p.org_id = p_org and p.deleted_at is null and nullif(trim(b ->> 'pledgeNumber'), '') is not null and p.donary_id = trim(b ->> 'pledgeNumber') limit 1;
      if v_existing is not null then
        v_out := jsonb_build_object('outcome', 'duplicate', 'record_id', v_existing);
      else
        v_id := 'MK-' || public.short_id();
        insert into public.pledges (org_id, id, reference, campaign_id, amount, name, phone, source, donary_id, collector, date_pledged, created_at)
        values (p_org, v_id, 'MK-PLG-' || coalesce(nullif(trim(b ->> 'pledgeNumber'), ''), public.short_id()),
                public.make_campaign(p_org, public.make_first(b -> 'campaignInfo') ->> 'campaignNumber'), v_amount,
                nullif(trim(concat_ws(' ', di ->> 'firstName', di ->> 'lastName')), ''), public.make_first(di -> 'donorPhones') ->> 'phoneNumber',
                'Donary', nullif(trim(b ->> 'pledgeNumber'), ''), b -> 'collectorInfo' ->> 'collectorName',
                public.make_time(b ->> 'deviceCreatedDate')::date, public.make_time(b ->> 'deviceCreatedDate'));
        insert into public.test_import_rows (batch_id, table_name, record_id, source_sheet, source_id)
        values (s.batch_id, 'pledges', v_id, 'make:donary-pledge', b ->> 'pledgeNumber');
        v_out := jsonb_build_object('outcome', 'created', 'record_id', v_id);
      end if;

    -- Donary void: void the matching donation, if there is one.
    when 'donary-void' then
      v_id := public.make_void(p_org, b ->> 'paymentNumber', b ->> 'gatewayRefNum', 'Voided in Donary (sent by Make)');
      v_out := case when v_id is null then jsonb_build_object('outcome', 'skipped', 'message', 'No matching donation')
                    else jsonb_build_object('outcome', 'voided', 'record_id', v_id) end;

    -- Sola: a sale or grant (Make filters to approved ones); a void voids the match; with xInvoice from a Donor Base
    -- payment page it's already recorded here.
    when 'sola' then
      v_cmd := lower(coalesce(b ->> 'xCommand', ''));
      if v_cmd like '%void%' or v_cmd like '%refund%' then
        v_id := public.make_void(p_org, null, coalesce(b ->> 'xRefNum', b ->> 'xResponseRefNum'), 'Voided at Sola (sent by Make)');
        v_out := case when v_id is null then jsonb_build_object('outcome', 'skipped', 'message', 'No matching donation')
                      else jsonb_build_object('outcome', 'voided', 'record_id', v_id) end;
      elsif nullif(trim(b ->> 'xInvoice'), '') is not null
            and exists (select 1 from public.gateway_transactions g where g.org_id = p_org and g.invoice = trim(b ->> 'xInvoice')) then
        v_out := jsonb_build_object('outcome', 'skipped', 'message', 'Already recorded by a Donor Base payment page');
      else
        v_amount := public.make_num(b ->> 'xAmount');
        if v_amount is null then raise exception 'No amount'; end if;
        v_existing := public.make_existing(p_org, null, coalesce(b ->> 'xRefNum', b ->> 'xResponseRefNum'));
        if v_existing is not null then
          v_out := jsonb_build_object('outcome', 'duplicate', 'record_id', v_existing);
        else
          v_id := public.make_new_donation(p_org, s.batch_id, p_source, jsonb_build_object(
            'campaign_id', public.make_campaign(p_org, b ->> 'xCustom02'), 'amount', v_amount,
            'status', case when lower(coalesce(b ->> 'xResponseResult', b ->> 'xResult', '')) in ('approved', 'a', '') then 'completed' else 'failed' end,
            'name', coalesce(nullif(trim(concat_ws(' ', b ->> 'xBillFirstName', b ->> 'xBillLastName')), ''), b ->> 'xName'),
            'phone', b ->> 'xBillPhone', 'email', b ->> 'xEmail', 'source', coalesce(nullif(trim(b ->> 'xSoftwareName'), ''), 'Sola'),
            'payment_method', case when v_cmd like 'grant%' then coalesce(b ->> 'xCardType', 'Grant') else 'Credit Card' end,
            'command', b ->> 'xCommand', 'result', coalesce(b ->> 'xResponseResult', b ->> 'xResult'), 'gateway_id', coalesce(b ->> 'xRefNum', b ->> 'xResponseRefNum'),
            'created_at', b ->> 'xEnteredDate'));
          v_out := jsonb_build_object('outcome', 'created', 'record_id', v_id);
        end if;
      end if;

    -- Elevon (Cartis): a succeeded payment; a void or refund voids the match.
    when 'elevon' then
      if lower(coalesce(b ->> 'payment_status', '')) in ('void', 'voided', 'refunded', 'refund', 'cancelled', 'canceled') then
        v_id := public.make_void(p_org, null, b -> 'payment_info' ->> 'referenceId', 'Voided at Elevon (sent by Make)');
        v_out := case when v_id is null then jsonb_build_object('outcome', 'skipped', 'message', 'No matching donation')
                      else jsonb_build_object('outcome', 'voided', 'record_id', v_id) end;
      else
        v_amount := public.make_num(b ->> 'amount');
        if v_amount is null then raise exception 'No amount'; end if;
        v_existing := public.make_existing(p_org, null, b -> 'payment_info' ->> 'referenceId');
        if v_existing is not null then
          v_out := jsonb_build_object('outcome', 'duplicate', 'record_id', v_existing);
        else
          v_id := public.make_new_donation(p_org, s.batch_id, p_source, jsonb_build_object(
            'campaign_id', public.make_campaign(p_org, b ->> 'external_campaign_id'), 'amount', v_amount,
            'status', case when lower(coalesce(b ->> 'payment_status', 'succeeded')) = 'succeeded' then 'completed' else public.make_status(b ->> 'payment_status') end,
            'name', b ->> 'name', 'phone', b -> 'billing_info' ->> 'phone', 'email', b -> 'billing_info' ->> 'email',
            'source', 'Cartis', 'payment_method', coalesce(nullif(trim(b ->> 'payment_method'), ''), 'Credit Card'), 'command', 'Sale',
            'result', b ->> 'payment_status', 'gateway_id', b -> 'payment_info' ->> 'referenceId', 'created_at', b ->> 'created_at'));
          v_out := jsonb_build_object('outcome', 'created', 'record_id', v_id);
        end if;
      end if;

    else
      return jsonb_build_object('ok', false, 'status', 400, 'error', 'Unknown source');
    end case;
  exception when others then
    -- The reason only (database messages here name columns, not people); nothing from the body.
    insert into public.make_ingest_log (org_id, source, outcome, message) values (p_org, p_source, 'error', left(sqlerrm, 200));
    return jsonb_build_object('ok', false, 'status', 422, 'error', left(sqlerrm, 200));
  end;

  insert into public.make_ingest_log (org_id, source, outcome, record_id, message)
  values (p_org, p_source, v_out ->> 'outcome', v_out ->> 'record_id', v_out ->> 'message');
  return jsonb_build_object('ok', true, 'status', case when v_out ->> 'outcome' = 'created' then 201 else 200 end) || v_out;
end $$;

-- The recent events, for the settings page (no personal details are kept in them).
create or replace function public.make_ingest_recent()
returns table (created_at timestamptz, source text, outcome text, record_id text, message text)
language sql stable security definer set search_path = '' as $$
  select l.created_at, l.source, l.outcome, l.record_id, l.message from public.make_ingest_log l
  where l.org_id = public.current_org_id() and public.is_admin()
  order by l.created_at desc limit 25
$$;

revoke execute on function public.make_ingest(uuid, text, text, jsonb), public.make_new_donation(uuid, text, text, jsonb), public.make_void(uuid, text, text, text),
  public.make_existing(uuid, text, text), public.make_source(uuid, text, text), public.make_campaign(uuid, text) from public, anon, authenticated;
grant execute on function public.make_ingest(uuid, text, text, jsonb) to service_role;
revoke execute on function public.make_ingest_status(), public.make_ingest_new_secret(), public.make_ingest_set_enabled(boolean), public.make_ingest_recent() from public, anon;
grant execute on function public.make_ingest_status(), public.make_ingest_new_secret(), public.make_ingest_set_enabled(boolean), public.make_ingest_recent() to authenticated;
