-- Readiness #1 (approved 2026-11-15): editing a donation's amount, payment method or campaign recalculates its fee from
-- the fee rules (and the net with it). A manual fee, a fee set by the same edit, and fees that came from a processor or
-- Donary feed are left alone. Also #59: a failed charge later marked completed gets its fee calculated.
CREATE OR REPLACE FUNCTION public.donation_defaults()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_window int;
begin
  if tg_op = 'UPDATE' then
    -- A manual fee replaces the fee; clearing it brings back the payment method's preset fee.
    if new.manual_fee is distinct from old.manual_fee then
      new.fee := coalesce(new.manual_fee,
        case when new.payment_method is not null then public.calculate_fee(new.org_id, new.campaign_id, new.payment_method, new.amount) end);
    -- Readiness #1 (2026-11-15): a changed amount, method or campaign brings the fee rule's fee again, unless a manual
    -- fee is set or the edit set the fee itself. Fees that came from a feed (card processor, Donary) are kept: those are
    -- the processor's own (card-processor rows are locked anyway). #59: a failed charge later completed gets its fee.
    elsif new.manual_fee is null and new.fee is not distinct from old.fee and new.payment_method is not null
          and new.gateway_id is null and new.donary_id is null
          and (new.amount is distinct from old.amount or new.payment_method is distinct from old.payment_method
               or new.campaign_id is distinct from old.campaign_id or (old.status = 'failed' and new.status <> 'failed')) then
      new.fee := public.calculate_fee(new.org_id, new.campaign_id, new.payment_method, new.amount);
      if new.net_donation is not distinct from old.net_donation then new.net_donation := new.amount - coalesce(new.fee, 0); end if;
    end if;
    if (new.amount is distinct from old.amount or new.fee is distinct from old.fee)
       and new.net_donation is not distinct from old.net_donation then
      new.net_donation := new.amount - coalesce(new.fee, 0);
    end if;
    return new;
  end if;

  -- Anything a fundraiser enters waits for an admin.
  if auth.uid() is not null and not public.is_admin() then
    new.status := 'pending';
  elsif new.post_dated and new.check_date > current_date and new.status = 'completed' then
    new.status := 'post_dated';
  end if;

  -- A manual fee overrides the payment method's preset fee; blank uses the preset.
  if new.manual_fee is not null then
    new.fee := new.manual_fee;
  elsif new.fee is null and new.payment_method is not null then
    new.fee := public.calculate_fee(new.org_id, new.campaign_id, new.payment_method, new.amount);
  end if;
  if new.net_donation is null then
    new.net_donation := new.amount - coalesce(new.fee, 0);
  end if;
  if new.type = 'Batch' and new.is_batch is null then
    new.is_batch := true;
  end if;
  new.account_id := coalesce(new.account_id, public.route_account(new.org_id, new.campaign_id, new.payment_method));

  -- Same donor, amount and campaign moments apart. Flags both; never blocks.
  if new.donor_id is not null and new.campaign_id is not null then
    select coalesce((s.value #>> '{}')::int, 10) into v_window
    from public.settings s where s.org_id = new.org_id and s.key = 'duplicate_window_minutes';
    update public.donations d set possible_duplicate = true
    where d.org_id = new.org_id and d.donor_id = new.donor_id and d.campaign_id = new.campaign_id and d.amount = new.amount
      and d.deleted_at is null and d.status not in ('voided','failed','rejected')
      and d.created_at between new.created_at - make_interval(mins => coalesce(v_window, 10)) and new.created_at + make_interval(mins => coalesce(v_window, 10));
    if found then new.possible_duplicate := true; end if;
  end if;
  return new;
end $function$;
