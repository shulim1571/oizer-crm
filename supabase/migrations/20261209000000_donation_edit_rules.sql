-- Editing a donation follows the rules (Moshe Henig, 2026-11-10: the Edit Donation status dropdown let a failed card
-- charge be changed to completed). When an admin edits a donation (the edit form, or bulk edit):
--   * the status can only move along the allowed steps below; anything else goes through its own action
--     (Approve / Reject, Refund, Returned check, Retry for a failed charge);
--   * a donation the card processor handled (it has a gateway transaction) keeps what the processor decided:
--     its status, amount, payment method, fee and time. Refunds and voids of those go through Sola.
-- Approve/Reject, refunds, returned checks, post-dated clearing and the processor's own results already
-- follow these steps or run as the system, so they are not affected. The list is kept in step with
-- src/lib/donationRules.ts (a test checks the two match).

create or replace function public.donation_status_allowed(p_from text, p_to text) returns boolean
language sql immutable set search_path = '' as $$
  select p_from is not distinct from p_to or (p_from, p_to) in (
    ('pending', 'completed'), ('pending', 'rejected'),
    ('post_dated', 'completed'), ('post_dated', 'voided'), ('post_dated', 'returned'),
    ('collect', 'completed'), ('collect', 'voided'), ('collect', 'failed'), ('collect', 'refunded'), ('collect', 'returned'),
    ('completed', 'voided'), ('completed', 'refunded'), ('completed', 'returned'), ('completed', 'collect')
  )
$$;

create or replace function public.donation_edit_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  -- Only people editing through the app; the system's own steps (processor results, scheduled jobs) run as their owner.
  if current_user not in ('authenticated', 'anon') or current_setting('oizer.trusted_edit', true) = 'on' then return new; end if;
  if exists (select 1 from public.gateway_transactions g where g.org_id = old.org_id and g.donation_id = old.id) then
    if new.status is distinct from old.status then
      raise exception 'This payment went through the card processor, so its status comes from there. Use Refund or Void at Sola, or Retry for a failed charge';
    end if;
    if new.amount is distinct from old.amount or new.payment_method is distinct from old.payment_method
       or new.fee is distinct from old.fee or new.manual_fee is distinct from old.manual_fee
       or new.created_at is distinct from old.created_at then
      raise exception 'This payment went through the card processor, so its amount, method, fee and time can''t be changed';
    end if;
  elsif not public.donation_status_allowed(old.status, new.status) then
    raise exception 'A % donation can''t be changed to %', old.status, new.status;
  end if;
  return new;
end $$;

-- Named to run before donation_defaults, so it sees what the person changed rather than what is worked out after.
drop trigger if exists aa_donation_edit_guard on public.donations;
create trigger aa_donation_edit_guard before update on public.donations
  for each row execute function public.donation_edit_guard();

-- Split keeps working on card payments: it marks itself as a trusted step (set_config can't be called from the app).
create or replace function public.split_donation(p_id text, p_legs jsonb, p_reason text default null) returns text
language plpgsql set search_path = '' as $$
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
end $$;

revoke execute on function public.donation_edit_guard() from public, anon, authenticated;
