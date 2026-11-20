-- Readiness #4 (approved 2026-11-15): refunds from Make (Sola, Elevon) are refunds, not voids.
--   * A full refund marks the payment refunded (its fee stays spent, as with Refund in the app), dated by the
--     processor's date in the organization's time zone.
--   * A partial refund is recorded as its own transaction for minus the refunded amount, on the same campaign, method
--     and account, linked to the payment (refund_of); the rest keeps counting. Its fee is 0 (the payment keeps its fee).
--   * Voids still void, now dated in the organization's time zone too.
-- The same partial refund is used by the app's Refund (readiness #17).
alter table public.donations add column if not exists refund_of text;
create index if not exists donations_org_refund_of_idx on public.donations (org_id, refund_of) where refund_of is not null;

create or replace function public.org_date(p_org uuid, p_when text default null) returns date
language sql stable set search_path = '' as $$
  select coalesce((nullif(public.local_time_text(p_when, p_org), '')::timestamptz at time zone public.org_zone(p_org))::date,
                  (now() at time zone public.org_zone(p_org))::date)
$$;

create or replace function public.make_void(p_org uuid, p_payment text, p_gateway text, p_why text) returns text
language plpgsql security definer set search_path = '' as $$
declare v_id text := public.make_existing(p_org, p_payment, p_gateway);
begin
  if v_id is null then return null; end if;
  update public.donations set status = 'voided', reversal_date = public.org_date(p_org), reversal_reason = p_why
  where org_id = p_org and id = v_id and status <> 'voided';
  return v_id;
end $$;

-- Refunds p_amount of a payment (all of what's left when p_amount is empty or covers it). Returns the payment's id.
create or replace function public.refund_part(p_org uuid, p_id text, p_amount numeric, p_date date, p_why text, p_method text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare d public.donations; v_done numeric; v_left numeric;
begin
  select * into d from public.donations where org_id = p_org and id = p_id for update;
  if d.id is null then return null; end if;
  if d.status = 'refunded' then return d.id; end if;   -- already fully refunded (a resend)
  if d.status not in ('completed', 'collect') then raise exception 'Only a completed transaction can be refunded'; end if;
  select coalesce(-sum(r.amount), 0) into v_done from public.donations r
    where r.org_id = p_org and r.refund_of = d.id and r.deleted_at is null and r.status = 'completed';
  v_left := d.amount - v_done;
  if p_amount is not null and p_amount <= 0 then raise exception 'Enter the amount refunded'; end if;
  if p_amount is not null and p_amount > v_left then raise exception 'That is more than the % left to refund', v_left; end if;
  if p_amount is null or p_amount >= v_left then
    -- All of it: the payment is refunded; earlier partial refunds are folded into it.
    update public.donations set status = 'voided', reversal_reason = 'Folded into the full refund of ' || d.id, reversal_date = p_date
      where org_id = p_org and refund_of = d.id and deleted_at is null and status = 'completed';
    update public.donations set status = 'refunded', reversal_date = p_date, reversal_reason = p_why, reversal_method = p_method
      where org_id = p_org and id = d.id;
  else
    insert into public.donations (org_id, campaign_id, donor_id, donor_label, type, status, amount, manual_fee, payment_method, source,
                                  account_id, name, notes, refund_of, created_at, created_by)
    values (p_org, d.campaign_id, d.donor_id, d.donor_label, 'Payment', 'completed', -round(p_amount, 2), 0, d.payment_method, d.source,
            d.account_id, d.name, 'Partial refund of ' || d.id || coalesce(' · ' || p_why, ''), d.id,
            (p_date + time '12:00') at time zone public.org_zone(p_org), coalesce(public.current_email(), 'Processor'));
  end if;
  return d.id;
end $$;
revoke execute on function public.refund_part(uuid, text, numeric, date, text, text) from public, anon, authenticated;

create or replace function public.make_refund(p_org uuid, p_payment text, p_gateway text, p_amount numeric, p_when text, p_why text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_id text := public.make_existing(p_org, p_payment, p_gateway);
begin
  if v_id is null then return null; end if;
  return public.refund_part(p_org, v_id, p_amount, public.org_date(p_org, p_when), p_why, 'Processor refund');
end $$;
revoke execute on function public.make_refund(uuid, text, text, numeric, text, text) from public, anon, authenticated;

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
      if v_cmd like '%refund%' then
        -- A refund is a refund, not a void (readiness #4): the fee stays spent, and part of a payment can be refunded.
        v_id := public.make_refund(p_org, null, coalesce(b ->> 'xRefNum', b ->> 'xResponseRefNum'), nullif(b ->> 'xAmount', '')::numeric,
                                   b ->> 'xEnteredDate', 'Refunded at Sola (sent by Make)');
        v_out := case when v_id is null then jsonb_build_object('outcome', 'skipped', 'message', 'No matching payment')
                      else jsonb_build_object('outcome', 'refunded', 'record_id', v_id) end;
      elsif v_cmd like '%void%' then
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
      if lower(coalesce(b ->> 'payment_status', '')) in ('refunded', 'refund', 'partially_refunded') then
        v_id := public.make_refund(p_org, null, b -> 'payment_info' ->> 'referenceId',
                                   nullif(coalesce(b ->> 'refund_amount', b ->> 'amount_refunded', b ->> 'amount'), '')::numeric,
                                   coalesce(b ->> 'refunded_at', b ->> 'updated_at', b ->> 'created_at'), 'Refunded at Elevon (sent by Make)');
        v_out := case when v_id is null then jsonb_build_object('outcome', 'skipped', 'message', 'No matching payment')
                      else jsonb_build_object('outcome', 'refunded', 'record_id', v_id) end;
      elsif lower(coalesce(b ->> 'payment_status', '')) in ('void', 'voided', 'cancelled', 'canceled') then
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
