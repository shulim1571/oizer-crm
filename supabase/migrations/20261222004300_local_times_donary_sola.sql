-- Transaction times from Donary and Sola were 5 hours early (Moshe Henig, 2026-11-15: "why is the timing on transactions
-- off?"). Both send local (New York) times with no time zone, e.g. 2026-11-15T12:54:02, and the database read a time
-- with no zone as UTC, so a gift at 12:54 pm showed as 7:54 am. Times with no zone from these two are now read in the
-- organization's time zone (org_zone); times that carry a zone (Z or +hh:mm) are taken as they are. Elevon's times
-- were already right and are unchanged. The transactions already brought in this way are corrected below.

-- A time with no zone, read in the organization's zone; one with a zone, unchanged. Returns a timestamp as text.
create or replace function public.local_time_text(p text, p_org uuid) returns text
language plpgsql stable set search_path = '' as $$
begin
  if nullif(trim(p), '') is null then return null; end if;
  if trim(p) ~ '(Z|[+-]\d\d(:?\d\d)?)$' then return trim(p); end if;
  return (trim(p)::timestamp at time zone public.org_zone(p_org))::text;
exception when others then
  return trim(p);   -- unreadable here: left as it was for the caller to read (or report)
end $$;

-- Donary's time, read in the organization's zone when it has none (the Donary connection's path).
create or replace function public.donary_time(p text, p_org uuid) returns timestamptz
language plpgsql stable set search_path = '' as $$
begin
  if p is null then return null; end if;
  return case when p ~ '(Z|[+-]\d\d:?\d\d)$' then p::timestamptz else p::timestamp at time zone public.org_zone(p_org) end;
exception when others then
  raise exception 'unmatched: unreadable date %', p;
end $$;

CREATE OR REPLACE FUNCTION public.make_ingest(p_org uuid, p_key text, p_source text, p_body jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
          'created_at', public.local_time_text(coalesce(b ->> 'processedDateTime', fp ->> 'processedDateTime', b ->> 'deviceCreatedDate'), p_org)));
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
                (public.make_time(public.local_time_text(b ->> 'deviceCreatedDate', p_org)) at time zone public.org_zone(p_org))::date, public.make_time(public.local_time_text(b ->> 'deviceCreatedDate', p_org)));
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
            'created_at', public.local_time_text(b ->> 'xEnteredDate', p_org)));
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
end $function$;

CREATE OR REPLACE FUNCTION public.donary_record_charge(p_org uuid, p jsonb)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
          coalesce(public.donary_time(public.dj(p, 'processedDateTime'), p_org), now()), 'Donary')
  returning id into v_id;
  return v_id;
end $function$;

CREATE OR REPLACE FUNCTION public.donary_apply(p_org uuid, p_event text, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
      reversal_date = coalesce((public.donary_time(public.dj(p, 'statusDateTime'), p_org) at time zone public.org_zone(p_org))::date, current_date)
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
end $function$;

-- Correct what already came in: Donary payments and Sola transactions from Make (their wall-clock time had been
-- stored as UTC), and pledges made from Donary through Make. The time of day moves to what Donary/Sola sent, read in
-- the organization's zone; the date pledged was already right.
update public.donations d set created_at = (d.created_at at time zone 'UTC') at time zone public.org_zone(d.org_id)
where d.id like 'MK-%'
  and exists (select 1 from public.make_ingest_log l where l.org_id = d.org_id and l.record_id = d.id and l.source in ('donary-payment', 'sola') and l.outcome = 'created');
update public.pledges p set created_at = (p.created_at at time zone 'UTC') at time zone public.org_zone(p.org_id)
where p.reference like 'MK-PLG-%';
