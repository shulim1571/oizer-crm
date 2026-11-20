-- Fees round UP to the cent, so the net (amount minus fee) rounds DOWN (Moshe Henig, 2026-11-15). This replaces
-- 20261222003500, which rounded fees down. The same calculations as there, now using fee_up:
--   * calculate_fee: every payment's fee (donation_defaults), the fee a donor covers on the payment page and on
--     recurring charges (cover_fee_total), so the campaign still keeps the full gift;
--   * add_voucher_funding: the fee on a voucher's funding;
--   * split_donation: back to how it was before 20261222003500. Splitting divides a fee already recorded (the total
--     doesn't change): each part's share to the nearest cent, the largest part taking what's left.
-- Fees typed in by hand and fees already recorded are not changed.
create or replace function public.fee_up(p numeric) returns numeric
language sql immutable set search_path = '' as $$
  -- Up to the next cent (also for a negative amount, so the net still rounds down), as a plain two-decimal amount.
  select round(ceil(p * 100) / 100, 2)
$$;

CREATE OR REPLACE FUNCTION public.calculate_fee(p_org uuid, p_campaign text, p_method text, p_amount numeric)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with recursive up as (
    select c.id, c.parent_campaign_id, 0 as depth from public.campaigns c where c.org_id = p_org and c.id = p_campaign
    union all
    select c.id, c.parent_campaign_id, up.depth + 1
    from up join public.campaigns c on c.org_id = p_org and c.id = up.parent_campaign_id
  )
  select public.fee_up(case r.fee_type
                 when 'flat' then r.fee_flat
                 when 'percent' then p_amount * r.fee_percent / 100
                 when 'percent_flat' then p_amount * r.fee_percent / 100 + r.fee_flat
                 else 0 end)
  from (
    select coalesce(o.fee_type, m.fee_type) fee_type, coalesce(o.fee_percent, m.fee_percent) fee_percent, coalesce(o.fee_flat, m.fee_flat) fee_flat
    from public.payment_methods m
    left join lateral (
      select f.fee_type, f.fee_percent, f.fee_flat
      from public.campaign_fee_overrides f join up on up.id = f.campaign_id
      where f.org_id = m.org_id and f.method_id = m.id
      order by up.depth limit 1
    ) o on true
    where m.org_id = p_org and lower(m.name) = lower(p_method)
  ) r
$function$;

CREATE OR REPLACE FUNCTION public.add_voucher_funding(p_voucher text, p_amount numeric, p_date date DEFAULT NULL::date, p_bank_reference text DEFAULT NULL::text, p_fee numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org uuid := public.current_org_id();
  v public.vouchers;
  v_funded numeric;
  v_fee numeric;
  v_status text;
  v_campaign text;
  v_id text;
begin
  perform public.require_admin();
  select * into v from public.vouchers where org_id = v_org and id = p_voucher and deleted_at is null for update;
  if v.id is null then raise exception 'Voucher not found'; end if;
  if v.cancelled_at is not null then raise exception 'This voucher was cancelled'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Enter an amount above zero'; end if;

  v_funded := public.voucher_funded(v_org, v.id);
  if v_funded + p_amount > v.face_value then
    update public.vouchers set overage_flag = true where org_id = v_org and id = v.id;
    return jsonb_build_object('ok', false, 'remaining', v.face_value - v_funded);
  end if;

  v_fee := coalesce(p_fee, public.fee_up(case v.fee_type
    when 'flat' then v.fee_flat
    when 'percent' then p_amount * v.fee_percent / 100
    when 'percent_flat' then p_amount * v.fee_percent / 100 + v.fee_flat
    else 0 end));

  -- A closed campaign takes nothing new: an admin assigns this elsewhere. Archived ones reactivate.
  v_campaign := v.campaign_id;
  select status into v_status from public.campaigns where org_id = v_org and id = v.campaign_id;
  if v_status = 'closed' then v_campaign := null; end if;

  insert into public.donations (org_id, campaign_id, donor_id, name, amount, fee, net_donation, payment_method, source, type, status,
                                voucher_id, batch_id, bank_reference, created_at, notes)
  values (v_org, v_campaign, v.donor_id, v.name, p_amount, v_fee, p_amount - v_fee, v.issuer, 'Manual', 'Payment', 'completed',
          v.id, v.issuer_number, p_bank_reference,
          case when p_date is null or p_date = current_date then now() else p_date::timestamptz end,
          case when v_status = 'closed' then 'Campaign ' || v.campaign_id || ' was closed when this voucher funded.' end)
  returning id into v_id;

  update public.vouchers set overage_flag = false where org_id = v_org and id = v.id and overage_flag;
  return jsonb_build_object('ok', true, 'donation_id', v_id, 'fee', v_fee, 'net', p_amount - v_fee);
end $function$;

CREATE OR REPLACE FUNCTION public.split_donation(p_id text, p_legs jsonb, p_reason text DEFAULT NULL::text)
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_org uuid := public.current_org_id();
  d public.donations;
  v_group text;
  v_total numeric := 0;
  v_fee_total numeric;
  v_fees numeric := 0;
  v_max numeric := -1;
  v_max_i int := 0;
  v_count int := jsonb_array_length(p_legs);
  v_amount numeric;
  v_fee numeric;
  i int;
begin
  -- Splitting re-divides the amount and fee across campaigns; the edit rules let it through.
  perform set_config('oizer.trusted_edit', 'on', true);
  perform public.require_admin();
  select * into d from public.donations where id = p_id and org_id = v_org and deleted_at is null for update;
  if d.id is null then raise exception 'Transaction not found'; end if;
  if d.status not in ('completed','collect') then raise exception 'Only a completed transaction can be split'; end if;
  if d.split_group_id is not null then raise exception 'This transaction is already split'; end if;
  if v_count < 2 then raise exception 'A split needs at least two campaigns'; end if;

  for i in 0 .. v_count - 1 loop
    v_amount := (p_legs -> i ->> 'amount')::numeric;
    if v_amount is null or v_amount <= 0 then raise exception 'Each part needs an amount above zero'; end if;
    if nullif(p_legs -> i ->> 'campaign_id', '') is null then raise exception 'Each part needs a campaign'; end if;
    v_total := v_total + v_amount;
    if v_amount > v_max then v_max := v_amount; v_max_i := i; end if;
  end loop;
  if v_total <> d.amount then
    raise exception 'The parts add up to % but the transaction is %', v_total, d.amount;
  end if;

  v_group := public.short_id();
  v_fee_total := coalesce(d.fee, 0);
  for i in 0 .. v_count - 1 loop
    if i <> v_max_i then
      v_fees := v_fees + round(v_fee_total * (p_legs -> i ->> 'amount')::numeric / v_total, 2);
    end if;
  end loop;

  for i in 0 .. v_count - 1 loop
    v_amount := (p_legs -> i ->> 'amount')::numeric;
    v_fee := case when i = v_max_i then v_fee_total - v_fees else round(v_fee_total * v_amount / v_total, 2) end;
    if i = 0 then
      update public.donations
      set campaign_id = p_legs -> 0 ->> 'campaign_id', amount = v_amount, fee = v_fee, net_donation = v_amount - v_fee,
          split_group_id = v_group, notes = case when p_reason is null then notes else concat_ws(E'\n', notes, 'Split: ' || p_reason) end
      where id = d.id and org_id = v_org;
    else
      insert into public.donations (org_id, campaign_id, donor_id, donor_label, collector_id, collector_label, type, status, amount, fee, net_donation,
                                    source, payment_method, name, phone, email, notes, account_id, split_group_id, created_at, anonymous, check_number)
      values (v_org, p_legs -> i ->> 'campaign_id', d.donor_id, d.donor_label, d.collector_id, d.collector_label, d.type, d.status, v_amount, v_fee, v_amount - v_fee,
              d.source, d.payment_method, d.name, d.phone, d.email, d.notes, d.account_id, v_group, d.created_at, d.anonymous, d.check_number);
    end if;
  end loop;
  return v_group;
end $function$;
