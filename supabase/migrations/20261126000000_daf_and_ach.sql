-- Phase 9 part 1: bank accounts (ACH) and DAF cards through each organization's own Sola account, beside
-- credit cards. The payment page and the office can take a gift from a checking or savings account, or from an
-- OJC, Pledger, Matbia or Donors Fund card. Bank and DAF details pass through the payment functions to Sola
-- and are never stored; only Sola's token is kept, encrypted, when one is saved for later or for a recurring
-- donation. A bank debit records the donor's authorization (the exact wording, the time and the connection),
-- as Nacha requires. ACH results arrive days later through Sola's webhook: a returned debit marks the gift
-- returned and goes on the Task Sheet. DAF grants can be voided but not refunded.

-- ---------------------------------------------------------------------------
-- What each organization takes, and how each attempt paid
-- ---------------------------------------------------------------------------
alter table public.payment_settings
  add column ach_enabled       boolean not null default false,
  add column daf_programs      text[] not null default '{}',
  add column ach_authorization text;

alter table public.gateway_transactions
  add column method      text not null default 'card' check (method in ('card','ach','daf')),
  add column daf_program text check (daf_program in ('OJC','Pledger','Matbia','Donors Fund')),
  add column ach_consent jsonb,
  add column settlement  text check (settlement in ('pending','settled','returned')),
  add column return_reason text;

alter table public.donor_cards
  add column method      text not null default 'card' check (method in ('card','ach','daf')),
  add column daf_program text;

-- The payment method a donation is recorded under, which sets its fee and receipt rules.
create or replace function public.gateway_method_name(p_method text, p_program text) returns text
language sql immutable set search_path = '' as $$
  select case p_method when 'ach' then 'ACH' when 'daf' then coalesce(p_program, 'DAF') || ' Online' else 'Credit Card' end
$$;

-- The wording a donor agrees to before a bank debit. An organization can replace it.
create or replace function public.ach_authorization_text(p_org uuid) returns text
language sql stable security definer set search_path = '' as $$
  select replace(coalesce(nullif(trim(s.ach_authorization), ''),
    'I authorize {org} to debit my bank account through the ACH network for the amount shown above, and, for a recurring '
    || 'donation, on the schedule shown above. The debit may take one to three business days. If my bank returns the debit '
    || 'for insufficient funds or incorrect account details, {org} may contact me to collect it another way and may charge '
    || 'returned-payment fees as the law allows. A recurring authorization stays in effect until I ask {org} to stop, giving '
    || 'enough notice for them to act on it.'), '{org}', o.name)
  from public.organizations o left join public.payment_settings s on s.org_id = o.id
  where o.id = p_org
$$;

-- ---------------------------------------------------------------------------
-- Settings (Super Admin) and what the screens see
-- ---------------------------------------------------------------------------
create or replace function public.save_payment_options(p_ach boolean, p_daf_programs text[], p_ach_authorization text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  if not public.is_super_admin() then raise exception 'Only the Super Admin can change the payment options'; end if;
  if exists (select 1 from unnest(coalesce(p_daf_programs, '{}')) x where x not in ('OJC','Pledger','Matbia','Donors Fund')) then
    raise exception 'Choose from OJC, Pledger, Matbia and Donors Fund';
  end if;
  if not exists (select 1 from public.payment_settings s where s.org_id = v_org) then
    raise exception 'Add the Sola keys first';
  end if;
  update public.payment_settings set
    ach_enabled = coalesce(p_ach, false),
    daf_programs = coalesce((select array_agg(distinct x order by x) from unnest(p_daf_programs) x), '{}'),
    ach_authorization = nullif(trim(p_ach_authorization), ''),
    updated_by = public.current_email(), updated_at = now()
  where org_id = v_org;
  perform public.write_activity(v_org, 'payment_options_changed', 'payment_settings', v_org::text, null,
    jsonb_build_object('ach', p_ach, 'daf_programs', p_daf_programs, 'custom_authorization', nullif(trim(p_ach_authorization), '') is not null));
end $$;

drop function public.payment_config();
create function public.payment_config()
returns table (ifields_key text, sandbox boolean, api_key_set boolean, pin_set boolean, updated_at timestamptz, updated_by text,
               ach_enabled boolean, daf_programs text[], ach_authorization text, ach_authorization_text text)
language sql stable security definer set search_path = '' as $$
  select s.ifields_key, s.sandbox, s.api_key is not null, s.webhook_pin is not null, s.updated_at, s.updated_by,
         s.ach_enabled, s.daf_programs, s.ach_authorization, public.ach_authorization_text(s.org_id)
  from public.payment_settings s
  where s.org_id = public.current_org_id() and public.is_admin()
$$;

-- ---------------------------------------------------------------------------
-- Cover the fee for the method chosen
-- ---------------------------------------------------------------------------
drop function public.cover_fee_total(uuid, text, numeric);
create function public.cover_fee_total(p_org uuid, p_campaign text, p_amount numeric, p_method text default 'Credit Card') returns numeric
language plpgsql stable security definer set search_path = '' as $$
declare v_method text := coalesce(p_method, 'Credit Card');
        v_total numeric := round(p_amount + coalesce(public.calculate_fee(p_org, p_campaign, v_method, p_amount), 0), 2); v_i int := 0;
begin
  while v_total - coalesce(public.calculate_fee(p_org, p_campaign, v_method, v_total), 0) < p_amount and v_i < 200 loop
    v_total := v_total + 0.01;
    v_i := v_i + 1;
  end loop;
  return v_total;
end $$;

drop function public.public_cover_fee(uuid, text, numeric);
create function public.public_cover_fee(p_org uuid, p_campaign text, p_amount numeric, p_method text default null) returns numeric
language sql stable security definer set search_path = '' as $$
  select case when p_amount > 0 and p_amount <= 1000000
              and exists (select 1 from public.campaigns c where c.org_id = p_org and c.id = p_campaign and c.deleted_at is null and c.status in ('active','archived'))
         then public.cover_fee_total(p_org, p_campaign, p_amount,
                case when p_method in ('ach','ACH') then 'ACH'
                     when p_method in ('OJC','Pledger','Matbia','Donors Fund') then p_method || ' Online'
                     else 'Credit Card' end) end
$$;

-- ---------------------------------------------------------------------------
-- The page: which methods it offers
-- ---------------------------------------------------------------------------
alter function public.public_give_page(uuid, text) rename to give_page_core;
revoke execute on function public.give_page_core(uuid, text) from public, anon, authenticated;

create function public.public_give_page(p_org uuid, p_campaign text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v jsonb := public.give_page_core(p_org, p_campaign); s public.payment_settings;
begin
  if v is null then return null; end if;
  select * into s from public.payment_settings where org_id = p_org;
  return jsonb_set(v, '{payments}', (v -> 'payments') || jsonb_build_object(
    'ach', coalesce(s.ach_enabled, false),
    'daf', to_jsonb(coalesce(s.daf_programs, '{}')),
    'ach_authorization', case when s.ach_enabled then public.ach_authorization_text(p_org) end));
end $$;

-- Bank details as the donor gave them: never the numbers, only the account type and last four.
create or replace function public.ach_consent_record(p_org uuid, p_ach jsonb, p_ip text, p_by text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if coalesce(p_ach ->> 'account_type', '') not in ('Checking','Savings') then raise exception 'Choose checking or savings'; end if;
  if coalesce(p_ach ->> 'last4', '') !~ '^\d{4}$' then raise exception 'Enter the account number'; end if;
  if nullif(trim(p_ach ->> 'name'), '') is null then raise exception 'Enter the name on the account'; end if;
  if not coalesce((p_ach ->> 'agreed')::boolean, false) then raise exception 'Please agree to the ACH authorization'; end if;
  return jsonb_build_object('wording', public.ach_authorization_text(p_org), 'agreed_at', now(), 'ip', p_ip, 'by', p_by,
                            'account_type', p_ach ->> 'account_type', 'last4', p_ach ->> 'last4', 'name', left(trim(p_ach ->> 'name'), 100));
end $$;

-- A gift from the page with any method. Checks the method, then the page's usual rules.
create or replace function public.begin_public_payment(
  p_org uuid, p_campaign text, p_amount numeric, p_cover_fee boolean, p_donor jsonb, p_custom jsonb, p_ip text,
  p_recurring jsonb, p_method text, p_program text default null, p_ach jsonb default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.payment_settings; v jsonb; v_total numeric; v_name text;
begin
  select * into s from public.payment_settings where org_id = p_org;
  if coalesce(p_method, '') not in ('card','ach','daf') then raise exception 'Choose how to pay'; end if;
  if p_method = 'ach' and not coalesce(s.ach_enabled, false) then raise exception 'This page doesn''t take bank payments'; end if;
  if p_method = 'daf' and not (coalesce(p_program, '') = any(coalesce(s.daf_programs, '{}'))) then raise exception 'This page doesn''t take that fund'; end if;
  if p_method = 'daf' and p_recurring is not null
     and coalesce(nullif(p_recurring ->> 'start', '')::date, (now() at time zone public.org_zone(p_org))::date) > (now() at time zone public.org_zone(p_org))::date then
    raise exception 'A recurring grant from a fund starts today';
  end if;
  v := public.begin_public_sale(p_org, p_campaign, p_amount, p_cover_fee, p_donor, p_custom, p_ip, p_recurring);
  v_name := public.gateway_method_name(p_method, case when p_method = 'daf' then p_program end);
  if p_method <> 'card' and (v ->> 'total')::numeric > round(p_amount, 2) then
    v_total := public.cover_fee_total(p_org, p_campaign, p_amount, v_name);
    v := jsonb_set(v, '{total}', to_jsonb(v_total));
  end if;
  update public.gateway_transactions set
    method = p_method, daf_program = case when p_method = 'daf' then p_program end,
    ach_consent = case when p_method = 'ach' then public.ach_consent_record(p_org, p_ach, p_ip, 'donor') end,
    amount = coalesce(v_total, amount), cover_fee = case when v_total is not null then v_total > round(p_amount, 2) else cover_fee end
  where org_id = p_org and id = (v ->> 'id')::uuid;
  return v;
end $$;

-- ---------------------------------------------------------------------------
-- The office: a charge or a save with any method
-- ---------------------------------------------------------------------------
create or replace function public.begin_admin_payment(
  p_method text, p_program text, p_campaign text, p_donor text, p_amount numeric, p_card uuid default null, p_save boolean default false,
  p_name text default null, p_email text default null, p_notes text default null, p_ip text default null, p_ach jsonb default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); s public.payment_settings; k public.donor_cards; v_id uuid; v_method text := coalesce(p_method, 'card');
begin
  perform public.require_admin();
  select * into s from public.payment_settings where org_id = v_org;
  if p_card is not null then
    select * into k from public.donor_cards where org_id = v_org and id = p_card and deleted_at is null;
    v_method := coalesce(k.method, 'card');
  elsif v_method not in ('card','ach','daf') then raise exception 'Choose how to pay';
  elsif v_method = 'ach' and not coalesce(s.ach_enabled, false) then raise exception 'Bank payments aren''t turned on. The Super Admin turns them on under Settings → Payments';
  elsif v_method = 'daf' and not (coalesce(p_program, '') = any(coalesce(s.daf_programs, '{}'))) then raise exception 'That fund isn''t turned on under Settings → Payments';
  end if;
  v_id := public.begin_card_sale(p_campaign, p_donor, p_amount, p_card, p_save, p_name, p_email, p_notes, p_ip);
  update public.gateway_transactions set
    method = v_method, daf_program = case when p_card is not null then k.daf_program when v_method = 'daf' then p_program end,
    ach_consent = case when v_method = 'ach' and p_card is null then public.ach_consent_record(v_org, p_ach, p_ip, public.current_email()) end
  where org_id = v_org and id = v_id;
  return v_id;
end $$;

-- Saves a bank account (or card) on a donor without charging it. DAF cards can't be saved without a grant.
create or replace function public.begin_admin_save(p_method text, p_donor text, p_name text default null, p_ip text default null, p_ach jsonb default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_id uuid;
begin
  perform public.require_admin();
  if coalesce(p_method, 'card') not in ('card','ach') then raise exception 'Only a card or a bank account can be saved without a payment'; end if;
  if p_method = 'ach' and not exists (select 1 from public.payment_settings s where s.org_id = v_org and s.ach_enabled) then
    raise exception 'Bank payments aren''t turned on. The Super Admin turns them on under Settings → Payments';
  end if;
  v_id := public.begin_card_save(p_donor, p_name, p_ip);
  update public.gateway_transactions set method = coalesce(p_method, 'card'),
    ach_consent = case when p_method = 'ach' then public.ach_consent_record(v_org, p_ach, p_ip, public.current_email()) end
  where org_id = v_org and id = v_id;
  return v_id;
end $$;

-- A void cancels a charge that hasn't settled; a refund returns a settled one in full. DAF grants only void.
create or replace function public.begin_card_reversal(p_donation text, p_kind text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); d public.donations; g public.gateway_transactions; v_id uuid;
begin
  perform public.require_admin();
  if p_kind not in ('void','refund') then raise exception 'Choose void or refund'; end if;
  select * into d from public.donations where org_id = v_org and id = p_donation and deleted_at is null;
  if d.id is null then raise exception 'Transaction not found'; end if;
  if d.status not in ('completed','collect') then raise exception 'Only a completed payment can be voided or refunded'; end if;
  select * into g from public.gateway_transactions
  where org_id = v_org and donation_id = p_donation and kind = 'sale' and status = 'approved' order by created_at desc limit 1;
  if g.id is null then raise exception 'This payment didn''t go through Sola, so mark it refunded instead'; end if;
  if g.method = 'daf' and p_kind = 'refund' then
    raise exception 'A % grant can be voided but not refunded through Sola. Once it can''t be voided, ask % to reverse it', g.daf_program, g.daf_program;
  end if;
  if exists (select 1 from public.gateway_transactions x where x.org_id = v_org and x.donation_id = p_donation and x.kind in ('void','refund')
             and (x.status = 'approved' or (x.status = 'pending' and x.created_at > now() - interval '2 minutes'))) then
    raise exception 'This payment is already being voided or refunded';
  end if;
  insert into public.gateway_transactions (org_id, invoice, kind, amount, campaign_id, donor_id, donation_id, original_ref, card_type, masked_card, method, daf_program)
  values (v_org, public.new_invoice(), p_kind, d.amount, d.campaign_id, d.donor_id, d.id, g.ref_num, g.card_type, g.masked_card, g.method, g.daf_program)
  returning id into v_id;
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- For the payment functions (service role)
-- ---------------------------------------------------------------------------
drop function public.claim_gateway_request(uuid, uuid);
create function public.claim_gateway_request(p_org uuid, p_id uuid)
returns table (kind text, invoice text, amount numeric, api_key text, sandbox boolean, card_token text, original_ref text,
               card_name text, email text, campaign_label text, save_card boolean, method text, daf_program text, account_type text)
language plpgsql security definer set search_path = '' as $$
declare g public.gateway_transactions; v_key text := public.payment_keys_key();
begin
  update public.gateway_transactions set attempted_at = now()
  where org_id = p_org and id = p_id and status = 'pending' and attempted_at is null
  returning * into g;
  if g.id is null then raise exception 'This payment was already sent'; end if;
  return query
    select g.kind, g.invoice, g.amount, extensions.pgp_sym_decrypt(s.api_key, v_key), s.sandbox,
           (select extensions.pgp_sym_decrypt(k.token, v_key) from public.donor_cards k where k.org_id = p_org and k.id = g.card_id and k.deleted_at is null),
           g.original_ref, g.card_name, g.email, public.campaign_label(p_org, g.campaign_id), g.save_card, g.method, g.daf_program,
           g.ach_consent ->> 'account_type'
    from public.payment_settings s where s.org_id = p_org;
end $$;

drop function public.claim_recurring_charges(integer);
create function public.claim_recurring_charges(p_limit integer default 25)
returns table (org_id uuid, id uuid, invoice text, amount numeric, api_key text, card_token text, campaign_label text, card_name text, email text,
               method text, daf_program text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare r record; v_id uuid; v_key text := public.payment_keys_key(); v_campaign text; v_amount numeric; v_name text; v_email text;
        k public.donor_cards;
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
    select * into k from public.donor_cards c where c.org_id = r.org_id and c.id = r.card_id;
    -- A closed campaign can't take the money; it lands unattributed for the office to place.
    select case when c.status = 'closed' or c.deleted_at is not null then null else c.id end into v_campaign
    from public.campaigns c where c.org_id = r.org_id and c.id = r.campaign_id;
    v_amount := case when r.cover_fee and v_campaign is not null
                     then public.cover_fee_total(r.org_id, v_campaign, r.amount, public.gateway_method_name(coalesce(k.method, 'card'), k.daf_program))
                     else r.amount end;
    select d.display_name, d.email into v_name, v_email from public.donors d where d.org_id = r.org_id and d.id = r.donor_id;
    insert into public.gateway_transactions (org_id, invoice, kind, amount, base_amount, cover_fee, campaign_id, donor_id, card_id, card_name, email,
                                             requested_by, requested_email, recurring_id, recurring_seq, attempted_at, method, daf_program)
    values (r.org_id, public.new_invoice(), 'sale', v_amount, r.amount, r.cover_fee and v_amount > r.amount, v_campaign, r.donor_id, r.card_id,
            v_name, v_email, null, 'Recurring donation', r.id, r.payments_made + 1, now(), coalesce(k.method, 'card'), k.daf_program)
    returning gateway_transactions.id into v_id;
    return query
      select r.org_id, v_id, g.invoice, g.amount, extensions.pgp_sym_decrypt(s.api_key, v_key),
             case when k.deleted_at is null then extensions.pgp_sym_decrypt(k.token, v_key) end,
             public.campaign_label(r.org_id, r.campaign_id), v_name, v_email, g.method, g.daf_program
      from public.gateway_transactions g join public.payment_settings s on s.org_id = g.org_id
      where g.org_id = r.org_id and g.id = v_id;
  end loop;
end $$;

-- Sola's answer. Bank debits and DAF grants are recorded under their own payment method; a bank debit waits
-- to settle. p_result may carry xMaskedAccountNumber in place of xMaskedCardNumber.
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
  v_masked text := coalesce(nullif(p_result ->> 'xMaskedCardNumber', ''), nullif(p_result ->> 'xMaskedAccountNumber', ''));
  v_online boolean;
  v_plan jsonb;
  v_rec uuid;
  v_start date;
  v_method_name text;
  v_type text;
  v_label text;
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
  if g.method = 'ach' and v_masked is null and g.ach_consent is not null then v_masked := 'xxxxx' || (g.ach_consent ->> 'last4'); end if;
  v_method_name := public.gateway_method_name(g.method, g.daf_program);
  v_type := case g.method
              when 'ach' then coalesce(g.ach_consent ->> 'account_type', g.card_type, 'Bank account')
              when 'daf' then g.daf_program
              else coalesce(p_result ->> 'xCardType', g.card_type, 'Card') end;
  v_label := case when v_masked is not null then
               case g.method when 'ach' then v_type || ' account ' || right(v_masked, 4)
                             when 'daf' then v_type || ' card ' || right(v_masked, 4)
                             else v_type || ' ' || right(v_masked, 4) end end;

  if g.kind = 'sale' then
    insert into public.donations (org_id, campaign_id, donor_id, amount, type, status, payment_method, source, gateway_id,
                                  name, email, phone, notes, created_by, fee_covered, custom_fields)
    values (p_org, g.campaign_id, v_donor, g.amount, 'Payment', case when v_status = 'approved' then 'completed' else 'failed' end,
            v_method_name, case when v_online and g.recurring_id is null then 'Online' else 'Manual' end, p_result ->> 'xRefNum',
            coalesce(g.card_name, (select dn.display_name from public.donors dn where dn.org_id = p_org and dn.id = v_donor)),
            g.email, g.donor_info ->> 'phone',
            concat_ws(' · ', g.notes,
              case when g.recurring_id is not null then 'Recurring payment ' || g.recurring_seq end,
              v_label,
              case when g.method = 'ach' and v_status = 'approved' then 'Bank debit, settles in 1–3 business days' end,
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
    perform public.refund_donation(g.donation_id, current_date, v_method_name, 'Refunded at Sola, ref ' || coalesce(p_result ->> 'xRefNum', ''));
  end if;

  -- The card or account, kept on the donor when asked (always for a recurring setup).
  if v_status = 'approved' and g.kind in ('sale','save') and (g.save_card or g.recurring_plan is not null)
     and v_donor is not null and nullif(p_result ->> 'xToken', '') is not null then
    insert into public.donor_cards (org_id, donor_id, token, masked, card_type, exp, name, created_by, method, daf_program)
    values (p_org, v_donor, extensions.pgp_sym_encrypt(p_result ->> 'xToken', public.payment_keys_key()), v_masked,
            v_type, case when g.method = 'ach' then null else p_result ->> 'xExp' end,
            coalesce(g.ach_consent ->> 'name', g.card_name), g.requested_email, g.method, g.daf_program)
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
    card_type = v_type, masked_card = coalesce(v_masked, masked_card),
    error = nullif(p_result ->> 'xError', ''), error_code = nullif(p_result ->> 'xErrorCode', ''),
    donation_id = coalesce(v_donation, donation_id), card_id = coalesce(v_card, card_id), donor_id = coalesce(v_donor, donor_id),
    recurring_id = coalesce(g.recurring_id, v_rec),
    settlement = case when g.method = 'ach' and g.kind = 'sale' and v_status = 'approved' then 'pending' end,
    response = p_result - 'xToken' - 'xCardNum' - 'xCVV' - 'xKey' - 'xAccount' - 'xRouting'
  where org_id = p_org and id = p_id
  returning * into g;
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.headers', '', true);
  return to_jsonb(g) - 'response';
end $$;

-- What Sola's webhook said. It finishes a charge whose answer we never got, and brings an ACH debit's
-- settlement: settled, or returned by the bank (the gift is marked returned and goes on the Task Sheet).
create or replace function public.record_gateway_event(p_org uuid, p_payload jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_invoice text := p_payload ->> 'xInvoice';
  v_ref text := p_payload ->> 'xRefNum';
  v_result text := coalesce(nullif(p_payload ->> 'xResult', ''), left(coalesce(p_payload ->> 'xResponseResult', p_payload ->> 'xStatus', ''), 1));
  v_clean jsonb := p_payload - 'xToken' - 'xCardNum' - 'xCVV' - 'xAccount' - 'xRouting';
  v_state text := lower(concat_ws(' ', p_payload ->> 'xStatus', p_payload ->> 'xTransactionStatus', p_payload ->> 'xResponseStatus', p_payload ->> 'xStatusCode'));
  v_reason text := coalesce(nullif(p_payload ->> 'xStatusReason', ''), nullif(p_payload ->> 'xReturnReason', ''), nullif(p_payload ->> 'xError', ''));
  g public.gateway_transactions;
  d public.donations;
begin
  if exists (select 1 from public.gateway_events e where e.org_id = p_org and e.ref_num is not distinct from v_ref and e.payload = v_clean) then
    return;
  end if;
  insert into public.gateway_events (org_id, ref_num, invoice, command, result, amount, payload)
  values (p_org, v_ref, v_invoice, p_payload ->> 'xCommand', v_result, nullif(p_payload ->> 'xAmount', '')::numeric, v_clean);

  select * into g from public.gateway_transactions
  where org_id = p_org and invoice = v_invoice and status = 'pending' and attempted_at < now() - interval '1 minute';
  if g.id is not null then
    perform public.record_gateway_result(p_org, g.id, jsonb_build_object(
      'xResult', v_result, 'xRefNum', v_ref, 'xError', p_payload ->> 'xError', 'xErrorCode', p_payload ->> 'xErrorCode',
      'xMaskedCardNumber', p_payload ->> 'xMaskedCardNumber', 'xMaskedAccountNumber', p_payload ->> 'xMaskedAccountNumber',
      'xCardType', p_payload ->> 'xCardType', 'xAuthCode', p_payload ->> 'xAuthCode', 'xToken', p_payload ->> 'xToken', 'xExp', p_payload ->> 'xExp'));
    return;
  end if;

  -- An ACH debit's later news.
  select * into g from public.gateway_transactions
  where org_id = p_org and method = 'ach' and kind = 'sale' and status = 'approved' and v_ref is not null and ref_num = v_ref;
  if g.id is null then return; end if;
  if v_state ~ '(^|\s)(18|14|returned|chargeback)(\s|$)' then
    if g.settlement is distinct from 'returned' then
      update public.gateway_transactions set settlement = 'returned', return_reason = v_reason where org_id = p_org and id = g.id;
      update public.donations set status = 'returned', reversal_date = (now() at time zone public.org_zone(p_org))::date,
             reversal_reason = 'Bank returned the ACH debit', reversal_notes = coalesce(v_reason, 'No reason given') || ' · Sola ref ' || v_ref
      where org_id = p_org and id = g.donation_id and status in ('completed','collect')
      returning * into d;
      if d.id is not null then
        insert into public.task_items (org_id, task_key, task_type, record_id, campaign_id, amount, summary)
        values (p_org, 'ach_returned:' || d.id, 'ach_returned', d.id, d.campaign_id, d.amount,
                coalesce(nullif(d.name, ''), 'A donor') || '''s bank returned ' || public.money_text(d.amount)
                  || coalesce(' from ' || (g.card_type) || ' account ' || right(g.masked_card, 4), '') || ' · ' || coalesce(v_reason, 'no reason given'))
        on conflict (org_id, task_key) do update set summary = excluded.summary, created_at = now(), resolved_at = null;
      end if;
    end if;
  elsif v_state ~ '(^|\s)(16|settled)(\s|$)' and g.settlement = 'pending' then
    update public.gateway_transactions set settlement = 'settled' where org_id = p_org and id = g.id;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Saved methods and the gateway log (admins)
-- ---------------------------------------------------------------------------
drop function public.donor_saved_cards(text);
create function public.donor_saved_cards(p_donor text)
returns table (id uuid, masked text, card_type text, exp text, name text, created_by text, created_at timestamptz, method text, daf_program text)
language sql stable security definer set search_path = '' as $$
  select k.id, k.masked, k.card_type, k.exp, k.name, k.created_by, k.created_at, k.method, k.daf_program
  from public.donor_cards k
  where public.is_admin() and k.org_id = public.current_org_id() and k.donor_id = p_donor and k.deleted_at is null
  order by k.created_at desc
$$;

drop function public.donation_gateway(text);
create function public.donation_gateway(p_donation text)
returns table (id uuid, kind text, status text, amount numeric, ref_num text, masked_card text, card_type text, error text,
               requested_email text, created_at timestamptz, method text, daf_program text, settlement text, return_reason text)
language sql stable security definer set search_path = '' as $$
  select g.id, g.kind, g.status, g.amount, g.ref_num, g.masked_card, g.card_type, g.error, g.requested_email, g.created_at,
         g.method, g.daf_program, g.settlement, g.return_reason
  from public.gateway_transactions g
  where public.is_admin() and g.org_id = public.current_org_id() and g.donation_id = p_donation
  order by g.created_at
$$;

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

do $$
declare f text;
begin
  foreach f in array array['cover_fee_total(uuid, text, numeric, text)', 'ach_consent_record(uuid, jsonb, text, text)',
                           'begin_public_payment(uuid, text, numeric, boolean, jsonb, jsonb, text, jsonb, text, text, jsonb)',
                           'claim_gateway_request(uuid, uuid)', 'claim_recurring_charges(integer)', 'ach_authorization_text(uuid)'] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
  foreach f in array array['begin_public_payment(uuid, text, numeric, boolean, jsonb, jsonb, text, jsonb, text, text, jsonb)',
                           'claim_gateway_request(uuid, uuid)', 'claim_recurring_charges(integer)'] loop
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
  foreach f in array array['save_payment_options(boolean, text[], text)', 'payment_config()',
                           'begin_admin_payment(text, text, text, text, numeric, uuid, boolean, text, text, text, text, jsonb)',
                           'begin_admin_save(text, text, text, text, jsonb)', 'donor_saved_cards(text)', 'donation_gateway(text)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  foreach f in array array['public_give_page(uuid, text)', 'public_cover_fee(uuid, text, numeric, text)'] loop
    execute format('revoke execute on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
end $$;
