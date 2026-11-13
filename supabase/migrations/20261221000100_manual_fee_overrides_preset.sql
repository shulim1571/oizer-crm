-- Manual fee works (Moshe Henig, 2026-11-11). It was saved but never used: the fee and net always came from the
-- payment method's preset. Now a manual fee is the payment's fee (net = amount - manual fee), overriding the preset;
-- left blank, the preset applies as before. Changing or clearing it on an existing payment recalculates fee and net.
-- Failed payments still carry no fee (zz_failed_has_no_fee runs after this).

create or replace function public.donation_defaults() returns trigger
language plpgsql security definer set search_path = '' as $function$
declare v_window int;
begin
  if tg_op = 'UPDATE' then
    -- A manual fee replaces the fee; clearing it brings back the payment method's preset fee.
    if new.manual_fee is distinct from old.manual_fee then
      new.fee := coalesce(new.manual_fee,
        case when new.payment_method is not null then public.calculate_fee(new.org_id, new.campaign_id, new.payment_method, new.amount) end);
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


-- The sample payments that already have a manual fee get it applied.
update public.donations set fee = manual_fee, net_donation = amount - manual_fee
where manual_fee is not null and fee is distinct from manual_fee and status <> 'failed' and deleted_at is null;
