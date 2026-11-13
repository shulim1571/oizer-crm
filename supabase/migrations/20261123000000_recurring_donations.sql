-- Phase 8 part 3: recurring donations, on our own schedule with the donor's saved Sola card. A donor sets one
-- up on the payment page (weekly, monthly, quarterly or annually, from a start date, until cancelled or for a
-- set number of payments), or an admin sets one up on a saved card. An hourly job charges whatever is due
-- through the recurring-charges function. A failed charge is tried again 3 days later and then 7 days after
-- that; after the third failure the schedule pauses and goes on the Task Sheet. Only successful charges count
-- toward a fixed number. A charge for a closed campaign still goes through and lands unattributed.
-- Everything about one charge, the donation and the schedule's next step, is recorded in one transaction.

create table public.recurring_donations (
  org_id          uuid not null default public.current_org_id() references public.organizations(id),
  id              uuid not null default gen_random_uuid(),
  donor_id        text not null,
  campaign_id     text not null,
  card_id         uuid,
  amount          numeric(12,2) not null check (amount > 0),
  cover_fee       boolean not null default false,
  frequency       text not null check (frequency in ('weekly','monthly','quarterly','annually')),
  start_date      date not null,
  total_payments  integer check (total_payments is null or total_payments between 1 and 520),
  payments_made   integer not null default 0,
  next_charge     date,
  status          text not null default 'active' check (status in ('active','paused','cancelled','completed')),
  pause_reason    text,
  failures        integer not null default 0,
  retry_on        date,
  last_error      text,
  last_charged_at timestamptz,
  notify_email    text,
  notify_phone    text,
  source          text not null default 'admin' check (source in ('page','admin')),
  created_by      text default public.current_email(),
  created_at      timestamptz not null default now(),
  cancelled_at    timestamptz,
  cancelled_by    text,
  cancel_reason   text,
  primary key (org_id, id),
  foreign key (org_id, donor_id) references public.donors (org_id, id)
);
create index recurring_due on public.recurring_donations (next_charge) where status = 'active';

alter table public.gateway_transactions
  add column recurring_id   uuid,
  add column recurring_seq  integer,
  add column recurring_plan jsonb;
alter table public.gateway_transactions drop constraint gateway_transactions_kind_check;
alter table public.gateway_transactions add constraint gateway_transactions_kind_check check (kind in ('sale','void','refund','save'));

-- The date of a schedule's nth payment, counted from its start so months never drift.
create or replace function public.recurring_date(p_start date, p_frequency text, p_n integer) returns date
language sql immutable as $$
  select (case p_frequency
            when 'weekly' then p_start + 7 * p_n
            when 'monthly' then p_start + make_interval(months => p_n)
            when 'quarterly' then p_start + make_interval(months => 3 * p_n)
            else p_start + make_interval(years => p_n) end)::date
$$;

create or replace function public.frequency_label(p text) returns text
language sql immutable as $$
  select case p when 'weekly' then 'week' when 'monthly' then 'month' when 'quarterly' then 'quarter' else 'year' end
$$;

-- Tells the donor about their schedule: set up, changed or cancelled.
create or replace function public.notify_recurring(p_org uuid, p_id uuid, p_event text) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.recurring_donations; v_campaign text; v_name text; v_lines text[];
begin
  select * into r from public.recurring_donations where org_id = p_org and id = p_id;
  if r.id is null or (r.notify_email is null and r.notify_phone is null) then return; end if;
  select coalesce(c.external_name, c.internal_name, c.campaign_name) into v_campaign from public.campaigns c where c.org_id = p_org and c.id = r.campaign_id;
  select d.display_name into v_name from public.donors d where d.org_id = p_org and d.id = r.donor_id;
  v_lines := case p_event
    when 'cancelled' then array['Your recurring donation of <b>' || public.money_text(r.amount) || '</b> each ' || public.frequency_label(r.frequency)
                               || ' to ' || public.html_escape(v_campaign) || ' has been cancelled. No further charges will be made.']
    else array[
      'Your recurring donation to <b>' || public.html_escape(v_campaign) || '</b>' || case p_event when 'changed' then ' has been changed.' else ' is set up.' end,
      '<b>' || public.money_text(r.amount) || '</b> each ' || public.frequency_label(r.frequency)
        || case when r.total_payments is not null then ', ' || r.total_payments || ' payments in all (' || public.money_text(r.amount * r.total_payments) || ')'
                else ', until you ask us to stop' end || '.',
      case when r.next_charge is not null and r.status = 'active' then 'Next charge: ' || to_char(r.next_charge, 'FMMonth FMDD, YYYY') else 'Payments made so far: ' || r.payments_made end,
      'To change or stop it, contact ' || public.html_escape((select coalesce(o.email, o.phone, o.name) from public.organizations o where o.id = p_org)) || '.']
  end;
  perform public.notify_person(p_org, r.notify_email, r.notify_phone, v_name,
    case when r.notify_email is not null and r.notify_phone is not null then 'both' when r.notify_phone is not null then 'sms' else 'email' end,
    'recurring', case p_event when 'cancelled' then 'Recurring donation cancelled' when 'changed' then 'Recurring donation changed' else 'Recurring donation confirmed' end,
    v_lines, null, null, r.id::text, r.campaign_id, r.donor_id);
end $$;

-- Tells the office and the campaign's fundraisers that a recurring charge failed.
create or replace function public.notify_recurring_failure(p_org uuid, p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.recurring_donations; v_lines text[]; v_subject text; a record; t record; v_name text; v_portal text := public.portal_url(p_org);
begin
  select * into r from public.recurring_donations where org_id = p_org and id = p_id;
  select d.display_name into v_name from public.donors d where d.org_id = p_org and d.id = r.donor_id;
  v_subject := case when r.status = 'paused' then 'Recurring donation paused after ' || r.failures || ' failed charges' else 'A recurring charge failed' end;
  v_lines := array[
    public.html_escape(coalesce(v_name, 'A donor')) || ': <b>' || public.money_text(r.amount) || '</b> each ' || public.frequency_label(r.frequency)
      || ' to ' || public.html_escape(public.campaign_label(p_org, r.campaign_id)),
    'Reason: ' || public.html_escape(coalesce(r.last_error, 'not given')),
    case when r.status = 'paused' then 'It won''t be tried again until someone updates the card or retries it.'
         else 'It will be tried again on ' || to_char(r.retry_on, 'FMMonth FMDD') || '.' end];
  for a in select * from public.notice_admins(p_org) loop
    perform public.notify_person(p_org, a.email, a.phone, a.name, (a.prefs).channels ->> 'donations', 'recurring_failed', v_subject, v_lines,
      v_portal || '#/recurring', 'Open recurring donations', r.id::text, r.campaign_id, r.donor_id);
  end loop;
  for t in select * from public.notice_team(p_org, r.campaign_id, 'donations') loop
    perform public.notify_person(p_org, t.email, t.phone, t.name, t.channel, 'recurring_failed', v_subject, v_lines,
      null, null, r.id::text, r.campaign_id, r.donor_id);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Recording Sola's answer, now also for saved-card setups and scheduled charges
-- ---------------------------------------------------------------------------
create or replace function public.record_gateway_result(p_org uuid, p_id uuid, p_result jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  g public.gateway_transactions;
  r public.recurring_donations;
  v_result text := upper(left(coalesce(p_result ->> 'xResult', ''), 1));
  v_status text;
  v_donation text;
  v_card uuid;
  v_donor text;
  v_masked text := p_result ->> 'xMaskedCardNumber';
  v_online boolean;
  v_plan jsonb;
  v_rec uuid;
  v_start date;
begin
  select * into g from public.gateway_transactions where org_id = p_org and id = p_id for update;
  if g.id is null then raise exception 'Transaction not found'; end if;
  if g.status <> 'pending' then return to_jsonb(g) - 'response'; end if;
  v_status := case v_result when 'A' then 'approved' when 'D' then 'declined' else 'error' end;
  v_online := g.requested_by is null;
  if not v_online then perform public.act_as_user(p_org, g.requested_by); end if;
  v_donor := g.donor_id;
  if v_online and v_status = 'approved' and g.donor_id is null and g.donor_info is not null then
    v_donor := public.find_or_add_donor(p_org, g.donor_info);
  end if;

  if g.kind = 'sale' then
    insert into public.donations (org_id, campaign_id, donor_id, amount, type, status, payment_method, source, gateway_id,
                                  name, email, phone, notes, created_by, fee_covered, custom_fields)
    values (p_org, g.campaign_id, v_donor, g.amount, 'Payment', case when v_status = 'approved' then 'completed' else 'failed' end,
            'Credit Card', case when v_online and g.recurring_id is null then 'Online' else 'Manual' end, p_result ->> 'xRefNum',
            coalesce(g.card_name, (select dn.display_name from public.donors dn where dn.org_id = p_org and dn.id = v_donor)),
            g.email, g.donor_info ->> 'phone',
            concat_ws(' · ', g.notes,
              case when g.recurring_id is not null then 'Recurring payment ' || g.recurring_seq end,
              case when v_masked is not null then coalesce(p_result ->> 'xCardType', 'Card') || ' ' || right(v_masked, 4) end,
              case when g.cover_fee then 'Donor covered the fee' end,
              case when v_status <> 'approved' then 'Declined: ' || coalesce(nullif(p_result ->> 'xError', ''), 'no reason given') end,
              case when v_online and g.recurring_id is null and v_status <> 'approved' then 'IP ' || g.ip end),
            g.requested_email, g.cover_fee, g.custom_fields)
    returning id into v_donation;
  elsif v_status = 'approved' and g.kind = 'void' then
    update public.donations set status = 'voided', reversal_date = current_date, reversal_reason = 'Voided at Sola',
           reversal_notes = 'Sola ref ' || coalesce(p_result ->> 'xRefNum', '')
    where org_id = p_org and id = g.donation_id;
  elsif v_status = 'approved' and g.kind = 'refund' then
    perform public.refund_donation(g.donation_id, current_date, 'Credit Card', 'Refunded at Sola, ref ' || coalesce(p_result ->> 'xRefNum', ''));
  end if;

  -- The card, kept on the donor when asked (always for a recurring setup).
  if v_status = 'approved' and g.kind in ('sale','save') and (g.save_card or g.recurring_plan is not null)
     and v_donor is not null and nullif(p_result ->> 'xToken', '') is not null then
    insert into public.donor_cards (org_id, donor_id, token, masked, card_type, exp, name, created_by)
    values (p_org, v_donor, extensions.pgp_sym_encrypt(p_result ->> 'xToken', public.payment_keys_key()), v_masked,
            p_result ->> 'xCardType', p_result ->> 'xExp', g.card_name, g.requested_email)
    returning id into v_card;
  end if;

  -- A new schedule: its first payment was this charge, or (a later start) nothing was charged yet.
  v_plan := g.recurring_plan;
  if v_status = 'approved' and v_plan is not null and v_card is not null then
    v_start := (v_plan ->> 'start')::date;
    insert into public.recurring_donations (org_id, donor_id, campaign_id, card_id, amount, cover_fee, frequency, start_date, total_payments,
                                            payments_made, next_charge, status, notify_email, notify_phone, source, created_by, last_charged_at)
    values (p_org, v_donor, g.campaign_id, v_card, coalesce(g.base_amount, g.amount), g.cover_fee, v_plan ->> 'frequency', v_start,
            nullif(v_plan ->> 'count', '')::int, case when g.kind = 'sale' then 1 else 0 end,
            case when g.kind = 'sale' and nullif(v_plan ->> 'count', '')::int = 1 then null
                 else public.recurring_date(v_start, v_plan ->> 'frequency', case when g.kind = 'sale' then 1 else 0 end) end,
            case when g.kind = 'sale' and nullif(v_plan ->> 'count', '')::int = 1 then 'completed' else 'active' end,
            coalesce(g.email, g.donor_info ->> 'email'), nullif(v_plan ->> 'notify_phone', ''),
            case when v_online then 'page' else 'admin' end, g.requested_email, case when g.kind = 'sale' then now() end)
    returning id into v_rec;
    perform public.notify_recurring(p_org, v_rec, 'created');
  end if;

  -- A scheduled charge moves its schedule on, or starts the retries.
  if g.recurring_id is not null then
    select * into r from public.recurring_donations where org_id = p_org and id = g.recurring_id for update;
    if v_status = 'approved' then
      update public.recurring_donations set
        payments_made = payments_made + 1, failures = 0, retry_on = null, last_error = null, last_charged_at = now(),
        status = case when total_payments is not null and payments_made + 1 >= total_payments then 'completed' else status end,
        next_charge = case when total_payments is not null and payments_made + 1 >= total_payments then null
                           else public.recurring_date(start_date, frequency, payments_made + 1) end
      where org_id = p_org and id = r.id;
      update public.task_items set resolved_at = now() where org_id = p_org and task_key = 'recurring_failed:' || r.id and resolved_at is null;
    else
      update public.recurring_donations set
        failures = failures + 1, last_error = coalesce(nullif(p_result ->> 'xError', ''), 'Declined'),
        retry_on = case failures + 1 when 1 then (now() at time zone public.org_zone(p_org))::date + 3 when 2 then (now() at time zone public.org_zone(p_org))::date + 7 end,
        status = case when failures + 1 >= 3 then 'paused' else status end,
        pause_reason = case when failures + 1 >= 3 then 'Three charges failed' else pause_reason end
      where org_id = p_org and id = r.id
      returning * into r;
      if r.status = 'paused' then
        insert into public.task_items (org_id, task_key, task_type, record_id, campaign_id, amount, summary)
        values (p_org, 'recurring_failed:' || r.id, 'recurring_failed', r.id::text, r.campaign_id, r.amount,
                coalesce(g.card_name, 'A donor') || ': ' || public.money_text(r.amount) || ' each ' || public.frequency_label(r.frequency)
                  || ' failed ' || r.failures || ' times · ' || coalesce(r.last_error, 'declined'))
        on conflict (org_id, task_key) do update set summary = excluded.summary, created_at = now(), resolved_at = null;
      end if;
      if r.failures = 1 or r.status = 'paused' then perform public.notify_recurring_failure(p_org, r.id); end if;
    end if;
  end if;

  update public.gateway_transactions set
    status = v_status, finished_at = now(),
    ref_num = p_result ->> 'xRefNum', auth_code = p_result ->> 'xAuthCode',
    card_type = coalesce(p_result ->> 'xCardType', card_type), masked_card = coalesce(v_masked, masked_card),
    error = nullif(p_result ->> 'xError', ''), error_code = nullif(p_result ->> 'xErrorCode', ''),
    donation_id = coalesce(v_donation, donation_id), card_id = coalesce(v_card, card_id), donor_id = coalesce(v_donor, donor_id),
    recurring_id = coalesce(g.recurring_id, v_rec),
    response = p_result - 'xToken' - 'xCardNum' - 'xCVV' - 'xKey'
  where org_id = p_org and id = p_id
  returning * into g;
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.headers', '', true);
  return to_jsonb(g) - 'response';
end $$;

-- ---------------------------------------------------------------------------
-- The payment page, now with a recurring choice
-- ---------------------------------------------------------------------------
drop function public.begin_public_sale(uuid, text, numeric, boolean, jsonb, jsonb, text);
create function public.begin_public_sale(
  p_org uuid, p_campaign text, p_amount numeric, p_cover_fee boolean, p_donor jsonb, p_custom jsonb, p_ip text, p_recurring jsonb default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_page jsonb := public.public_give_page(p_org, p_campaign);
  v_total numeric;
  v_id uuid;
  v_token text := encode(extensions.gen_random_bytes(18), 'hex');
  f jsonb;
  v_answer text;
  v_today date := (now() at time zone public.org_zone(p_org))::date;
  v_start date;
  v_count integer;
  v_kind text := 'sale';
begin
  if v_page is null then raise exception 'This page isn''t taking donations'; end if;
  if not (v_page #>> '{payments,ready}')::boolean then raise exception 'This page isn''t taking card donations yet'; end if;
  if p_ip is not null then
    if (select count(*) from public.gateway_transactions g where g.ip = p_ip and g.requested_by is null
          and g.status in ('declined','error') and g.created_at > now() - interval '1 hour') >= 5
       or (select count(*) from public.gateway_transactions g where g.ip = p_ip and g.requested_by is null
             and g.created_at > now() - interval '1 hour') >= 20 then
      raise exception 'Too many attempts from this connection. Please try again later';
    end if;
  end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'Choose an amount'; end if;
  if p_amount > 1000000 then raise exception 'Please call the office to give this amount'; end if;
  if (v_page #>> '{page,min}') is not null and p_amount < (v_page #>> '{page,min}')::numeric then
    raise exception 'The smallest gift here is $%', v_page #>> '{page,min}';
  end if;
  if not (v_page #>> '{page,allow_other}')::boolean and not (v_page -> 'page' -> 'presets') @> to_jsonb(round(p_amount, 2)) then
    raise exception 'Choose one of the amounts';
  end if;
  if nullif(trim(p_donor ->> 'first_name'), '') is null or nullif(trim(p_donor ->> 'last_name'), '') is null then raise exception 'Enter your first and last name'; end if;
  if public.normalize_phone(p_donor ->> 'phone') is null and length(regexp_replace(coalesce(p_donor ->> 'phone', ''), '\D', '', 'g')) < 7 then
    raise exception 'Enter your phone number';
  end if;
  if nullif(trim(p_donor ->> 'email'), '') is not null and public.normalize_address('email', p_donor ->> 'email') is null then
    raise exception 'Check your email address';
  end if;
  for f in select * from jsonb_array_elements(v_page #> '{page,custom_fields}') loop
    v_answer := p_custom ->> (f ->> 'name');
    if coalesce((f ->> 'required')::boolean, false) and (v_answer is null or trim(v_answer) = '' or v_answer = 'false') then
      raise exception '% is required', f ->> 'name';
    end if;
  end loop;
  if p_recurring is not null then
    if coalesce(p_recurring ->> 'frequency', '') not in ('weekly','monthly','quarterly','annually') then raise exception 'Choose how often'; end if;
    v_start := coalesce(nullif(p_recurring ->> 'start', '')::date, v_today);
    if v_start < v_today or v_start > v_today + 365 then raise exception 'Choose a start date within the next year'; end if;
    v_count := nullif(p_recurring ->> 'count', '')::int;
    if v_count is not null and (v_count < 2 or v_count > 520) then raise exception 'Choose between 2 and 520 payments, or until you cancel'; end if;
    if v_start > v_today then v_kind := 'save'; end if;
    p_recurring := jsonb_build_object('frequency', p_recurring ->> 'frequency', 'start', v_start, 'count', v_count,
                                      'notify_phone', case when coalesce((p_recurring ->> 'text_me')::boolean, false) then p_donor ->> 'phone' end);
  end if;
  v_total := case when p_cover_fee and (v_page #>> '{page,cover_fee}')::boolean then public.cover_fee_total(p_org, p_campaign, p_amount) else round(p_amount, 2) end;
  insert into public.gateway_transactions (org_id, invoice, kind, amount, base_amount, cover_fee, campaign_id, card_name, email, notes, ip,
                                           requested_by, requested_email, donor_info, custom_fields, public_token, recurring_plan)
  values (p_org, public.new_invoice(), v_kind, v_total, round(p_amount, 2), coalesce(p_cover_fee, false) and v_total > p_amount, p_campaign,
          trim(p_donor ->> 'first_name') || ' ' || trim(p_donor ->> 'last_name'), nullif(trim(p_donor ->> 'email'), ''),
          nullif(left(trim(p_donor ->> 'notes'), 1000), ''), p_ip, null, 'Online payment page',
          jsonb_strip_nulls(jsonb_build_object(
            'first_name', left(trim(p_donor ->> 'first_name'), 80), 'last_name', left(trim(p_donor ->> 'last_name'), 80),
            'phone', left(trim(p_donor ->> 'phone'), 40), 'email', nullif(left(trim(p_donor ->> 'email'), 200), ''),
            'address', nullif(left(trim(p_donor ->> 'address'), 300), ''), 'country', nullif(left(trim(p_donor ->> 'country'), 40), ''))),
          nullif(p_custom, '{}'::jsonb), v_token, p_recurring)
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'token', v_token, 'total', v_total, 'kind', v_kind);
end $$;

-- ---------------------------------------------------------------------------
-- Scheduled charges (the recurring-charges function, service role)
-- ---------------------------------------------------------------------------
-- Starts a charge for each schedule that's due, at most p_limit, with what Sola needs. A schedule whose charge
-- for this payment is already approved, or still being sent, is not charged again.
create or replace function public.claim_recurring_charges(p_limit integer default 25)
returns table (org_id uuid, id uuid, invoice text, amount numeric, api_key text, card_token text, campaign_label text, card_name text, email text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare r record; v_id uuid; v_key text := public.payment_keys_key(); v_campaign text; v_amount numeric; v_name text; v_email text;
begin
  for r in
    select x.* from public.recurring_donations x
    join public.organizations o on o.id = x.org_id and o.status = 'active'
    join public.payment_settings s on s.org_id = x.org_id and s.api_key is not null
    where x.status = 'active' and x.next_charge is not null
      and coalesce(x.retry_on, x.next_charge) <= (now() at time zone public.org_zone(x.org_id))::date
      and not exists (select 1 from public.gateway_transactions g where g.org_id = x.org_id and g.recurring_id = x.id
                      and g.recurring_seq = x.payments_made + 1
                      and (g.status = 'approved' or (g.status = 'pending' and g.created_at > now() - interval '1 hour')))
    order by x.next_charge
    limit p_limit
    for update of x skip locked
  loop
    -- A closed campaign can't take the money; it lands unattributed for the office to place.
    select case when c.status = 'closed' or c.deleted_at is not null then null else c.id end into v_campaign
    from public.campaigns c where c.org_id = r.org_id and c.id = r.campaign_id;
    v_amount := case when r.cover_fee and v_campaign is not null then public.cover_fee_total(r.org_id, v_campaign, r.amount) else r.amount end;
    select d.display_name, d.email into v_name, v_email from public.donors d where d.org_id = r.org_id and d.id = r.donor_id;
    insert into public.gateway_transactions (org_id, invoice, kind, amount, base_amount, cover_fee, campaign_id, donor_id, card_id, card_name, email,
                                             requested_by, requested_email, recurring_id, recurring_seq, attempted_at)
    values (r.org_id, public.new_invoice(), 'sale', v_amount, r.amount, r.cover_fee and v_amount > r.amount, v_campaign, r.donor_id, r.card_id,
            v_name, v_email, null, 'Recurring donation', r.id, r.payments_made + 1, now())
    returning gateway_transactions.id into v_id;
    return query
      select r.org_id, v_id, g.invoice, g.amount, extensions.pgp_sym_decrypt(s.api_key, v_key),
             (select extensions.pgp_sym_decrypt(k.token, v_key) from public.donor_cards k where k.org_id = r.org_id and k.id = r.card_id and k.deleted_at is null),
             public.campaign_label(r.org_id, r.campaign_id), v_name, v_email
      from public.gateway_transactions g join public.payment_settings s on s.org_id = g.org_id
      where g.org_id = r.org_id and g.id = v_id;
  end loop;
end $$;

-- Wakes the recurring-charges function when something is due, like the message sender.
create or replace function public.kick_recurring() returns void
language plpgsql security definer set search_path = '' as $$
declare v_url text; v_token text;
begin
  if not exists (select 1 from public.recurring_donations x where x.status = 'active' and x.next_charge is not null
                 and coalesce(x.retry_on, x.next_charge) <= (now() at time zone public.org_zone(x.org_id))::date) then
    return;
  end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into v_token from vault.decrypted_secrets where name = 'messaging_cron_token';
  if v_url is null or v_token is null then return; end if;
  perform net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/recurring-charges',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-token', v_token),
    body := '{}'::jsonb);
end $$;

-- ---------------------------------------------------------------------------
-- Admin management
-- ---------------------------------------------------------------------------
-- A schedule on one of the donor's saved cards, set up by the office.
create or replace function public.create_recurring(
  p_donor text, p_campaign text, p_card uuid, p_amount numeric, p_frequency text, p_start date, p_count integer default null,
  p_notify_email text default null, p_notify_phone text default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_id uuid;
begin
  perform public.require_admin();
  if not exists (select 1 from public.donor_cards k where k.org_id = v_org and k.id = p_card and k.donor_id = p_donor and k.deleted_at is null) then
    raise exception 'Choose one of this donor''s saved cards';
  end if;
  if not exists (select 1 from public.campaigns c where c.org_id = v_org and c.id = p_campaign and c.deleted_at is null and c.status <> 'closed') then
    raise exception 'Choose an open campaign';
  end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'Enter an amount'; end if;
  if p_frequency not in ('weekly','monthly','quarterly','annually') then raise exception 'Choose how often'; end if;
  if p_start is null or p_start < public.org_today() then raise exception 'Start today or later'; end if;
  if p_count is not null and (p_count < 1 or p_count > 520) then raise exception 'Choose between 1 and 520 payments'; end if;
  insert into public.recurring_donations (org_id, donor_id, campaign_id, card_id, amount, frequency, start_date, total_payments, next_charge,
                                          notify_email, notify_phone, source)
  values (v_org, p_donor, p_campaign, p_card, round(p_amount, 2), p_frequency, p_start, p_count, p_start,
          nullif(lower(trim(p_notify_email)), ''), nullif(trim(p_notify_phone), ''), 'admin')
  returning id into v_id;
  perform public.notify_recurring(v_org, v_id, 'created');
  perform public.kick_recurring();
  return v_id;
end $$;

-- Admin: saves a card on a donor without charging it, for a recurring donation or later charges.
create or replace function public.begin_card_save(p_donor text, p_name text default null, p_ip text default null) returns uuid
language plpgsql security definer set search_path = '' as $fn$
declare v_org uuid := public.current_org_id(); v_id uuid;
begin
  perform public.require_admin();
  if not exists (select 1 from public.payment_settings s where s.org_id = v_org and s.api_key is not null) then
    raise exception 'Card payments aren''t set up yet';
  end if;
  if not exists (select 1 from public.donors d where d.org_id = v_org and d.id = p_donor and d.deleted_at is null) then raise exception 'Donor not found'; end if;
  insert into public.gateway_transactions (org_id, invoice, kind, amount, donor_id, save_card, card_name, ip)
  values (v_org, public.new_invoice(), 'save', 0.01, p_donor, true, nullif(trim(p_name), ''), p_ip)
  returning id into v_id;
  return v_id;
end $fn$;

-- Changes the amount, frequency or card. A change of frequency starts the new rhythm from the next charge date.
create or replace function public.update_recurring(p_id uuid, p_amount numeric, p_frequency text, p_card uuid, p_next date default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); r public.recurring_donations; v_next date;
begin
  perform public.require_admin();
  select * into r from public.recurring_donations where org_id = v_org and id = p_id for update;
  if r.id is null then raise exception 'Recurring donation not found'; end if;
  if r.status in ('cancelled','completed') then raise exception 'This recurring donation has ended'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'Enter an amount'; end if;
  if p_frequency not in ('weekly','monthly','quarterly','annually') then raise exception 'Choose how often'; end if;
  if not exists (select 1 from public.donor_cards k where k.org_id = v_org and k.id = p_card and k.donor_id = r.donor_id and k.deleted_at is null) then
    raise exception 'Choose one of this donor''s saved cards';
  end if;
  v_next := coalesce(p_next, r.next_charge, public.org_today());
  if v_next < public.org_today() then raise exception 'The next charge can''t be in the past'; end if;
  update public.recurring_donations set amount = round(p_amount, 2), card_id = p_card,
    frequency = p_frequency,
    -- Counted afresh from the next charge, so the new rhythm and the payments already made both hold.
    start_date = case when p_frequency <> r.frequency or p_next is not null then public.recurring_date(v_next, p_frequency, -r.payments_made) else start_date end,
    next_charge = v_next,
    failures = case when p_card <> r.card_id then 0 else failures end,
    retry_on = case when p_card <> r.card_id then null else retry_on end
  where org_id = v_org and id = p_id;
  if p_amount <> r.amount or p_frequency <> r.frequency then perform public.notify_recurring(v_org, p_id, 'changed'); end if;
end $$;

-- Pauses, resumes, retries now or cancels.
create or replace function public.set_recurring_status(p_id uuid, p_action text, p_reason text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); r public.recurring_donations; v_today date := public.org_today();
begin
  perform public.require_admin();
  select * into r from public.recurring_donations where org_id = v_org and id = p_id for update;
  if r.id is null then raise exception 'Recurring donation not found'; end if;
  if r.status in ('cancelled','completed') then raise exception 'This recurring donation has ended'; end if;
  if p_action = 'pause' then
    update public.recurring_donations set status = 'paused', pause_reason = coalesce(nullif(trim(p_reason), ''), 'Paused by the office') where org_id = v_org and id = p_id;
  elsif p_action = 'resume' then
    update public.recurring_donations set status = 'active', pause_reason = null, failures = 0, retry_on = null,
      next_charge = greatest(coalesce(next_charge, v_today), v_today)
    where org_id = v_org and id = p_id;
  elsif p_action = 'retry' then
    update public.recurring_donations set status = 'active', pause_reason = null, retry_on = v_today where org_id = v_org and id = p_id;
  elsif p_action = 'cancel' then
    update public.recurring_donations set status = 'cancelled', next_charge = null, retry_on = null, cancelled_at = now(),
      cancelled_by = public.current_email(), cancel_reason = nullif(trim(p_reason), '')
    where org_id = v_org and id = p_id;
    perform public.notify_recurring(v_org, p_id, 'cancelled');
  else
    raise exception 'Unknown action';
  end if;
  if p_action <> 'pause' then
    update public.task_items set resolved_at = now() where org_id = v_org and task_key = 'recurring_failed:' || p_id and resolved_at is null;
  end if;
  if p_action in ('resume','retry') then perform public.kick_recurring(); end if;
end $$;

-- Deleting a saved card ends any recurring donation it pays for, and the donor is told.
create or replace function public.delete_donor_card(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); r record;
begin
  perform public.require_admin();
  update public.donor_cards set deleted_at = now(), deleted_by = public.current_email(), token = '\x'::bytea
  where org_id = v_org and id = p_id and deleted_at is null;
  if not found then raise exception 'Card not found'; end if;
  for r in select x.id from public.recurring_donations x where x.org_id = v_org and x.card_id = p_id and x.status in ('active','paused') loop
    update public.recurring_donations set status = 'cancelled', next_charge = null, retry_on = null, cancelled_at = now(),
      cancelled_by = public.current_email(), cancel_reason = 'Its card was deleted'
    where org_id = v_org and id = r.id;
    perform public.notify_recurring(v_org, r.id, 'cancelled');
  end loop;
end $$;

-- A schedule's card as people may see it: never the token.
create or replace function public.recurring_card(p_org uuid, p_card uuid) returns table (masked text, card_type text, exp text)
language sql stable security definer set search_path = '' as $fn$
  select k.masked, k.card_type, k.exp from public.donor_cards k
  where k.org_id = p_org and k.id = p_card and p_org = public.current_org_id() and public.is_active_user()
$fn$;

-- Recurring donations with what's left to come, for the Recurring page, the campaign and the donor.
create view public.recurring_list with (security_invoker = true) as
select x.*, coalesce(dn.display_name, '') as donor_name, public.campaign_label(x.org_id, x.campaign_id) as campaign_label,
       k.masked as card_masked, k.card_type, k.exp as card_exp,
       case when x.status = 'active' and x.next_charge is not null then
         (select count(*) from generate_series(0, coalesce(x.total_payments - x.payments_made - 1, 400)) n
          where public.recurring_date(x.next_charge, x.frequency, n) <= current_date + 30) end as due_30,
       case when x.status = 'active' and x.next_charge is not null then
         (select count(*) from generate_series(0, coalesce(x.total_payments - x.payments_made - 1, 400)) n
          where public.recurring_date(x.next_charge, x.frequency, n) <= current_date + 90) end as due_90,
       case when x.total_payments is not null then public.recurring_date(x.start_date, x.frequency, x.total_payments - 1) end as final_charge
from public.recurring_donations x
left join public.donors dn on dn.org_id = x.org_id and dn.id = x.donor_id
left join lateral public.recurring_card(x.org_id, x.card_id) k on true;

-- ---------------------------------------------------------------------------
-- Access and the hourly job
-- ---------------------------------------------------------------------------
alter table public.recurring_donations enable row level security;
revoke all on public.recurring_donations, public.recurring_list from anon;
revoke insert, update, delete on public.recurring_donations from authenticated;
create policy org_wall on public.recurring_donations as restrictive for all to authenticated
  using (org_id = (select public.current_org_id())) with check (org_id = (select public.current_org_id()));
create policy admin_read on public.recurring_donations for select to authenticated using ((select public.is_admin()));
create policy manager_read on public.recurring_donations for select to authenticated
  using (campaign_id = any((select public.my_campaign_ids())::text[]));
grant select on public.recurring_list to authenticated;
create trigger log_row_change after insert or update or delete on public.recurring_donations for each row execute function public.log_row_change();

do $$
declare f text;
begin
  foreach f in array array['notify_recurring(uuid, uuid, text)', 'notify_recurring_failure(uuid, uuid)', 'record_gateway_result(uuid, uuid, jsonb)',
                           'begin_public_sale(uuid, text, numeric, boolean, jsonb, jsonb, text, jsonb)', 'claim_recurring_charges(integer)', 'kick_recurring()'] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
  foreach f in array array['record_gateway_result(uuid, uuid, jsonb)', 'begin_public_sale(uuid, text, numeric, boolean, jsonb, jsonb, text, jsonb)',
                           'claim_recurring_charges(integer)'] loop
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
  foreach f in array array['create_recurring(text, text, uuid, numeric, text, date, integer, text, text)', 'update_recurring(uuid, numeric, text, uuid, date)',
                           'set_recurring_status(uuid, text, text)', 'delete_donor_card(uuid)', 'begin_card_save(text, text, text)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  foreach f in array array['recurring_date(date, text, integer)', 'frequency_label(text)', 'recurring_card(uuid, uuid)'] loop
    execute format('revoke execute on function public.%s from anon', f);
  end loop;
end $$;

select cron.schedule('recurring_charges', '7 * * * *', $$select public.kick_recurring()$$);
