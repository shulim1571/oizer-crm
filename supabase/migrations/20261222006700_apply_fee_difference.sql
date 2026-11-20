-- Readiness #30 (2026-11-15): when a processor deposit comes in short of its gifts because of its real fees, the
-- match records the difference as "processor fees", but the gifts kept their preset fees, so campaign fees didn't
-- show the real cost. "Apply fee difference" sets those gifts' fees to the real total (gifts less the deposit),
-- shared by amount, each share rounded up and the last (largest) gift taking what's left, so they add up exactly.
-- Each share is kept as the gift's manual fee (a later edit won't put the preset back), every change is in the
-- activity log, and a match can be applied once.

alter table public.recon_matches add column if not exists fee_applied_at timestamptz;
alter table public.recon_matches add column if not exists fee_applied_by text;

create or replace function public.apply_fee_difference(p_match text) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  m public.recon_matches;
  v_total numeric;
  v_sum numeric;
  v_given numeric := 0;
  v_fee numeric;
  v_n integer;
  v_i integer := 0;
  r record;
begin
  perform public.require_admin();
  select * into m from public.recon_matches where org_id = v_org and id = p_match for update;
  if m.id is null then raise exception 'Match not found'; end if;
  if m.difference_type is distinct from 'processor_fees' or m.difference >= 0 then
    raise exception 'Only a match short by processor fees can have them applied';
  end if;
  if m.fee_applied_at is not null then raise exception 'The fee difference was already applied (% by %)', to_char(m.fee_applied_at, 'Mon DD, YYYY'), m.fee_applied_by; end if;
  if exists (select 1 from public.recon_match_items i where i.org_id = v_org and i.match_id = m.id and i.item_type not in ('donation', 'donation_split')) then
    raise exception 'This match has more than gifts in it, so the fee can''t be shared out';
  end if;

  create temp table if not exists pg_temp.fee_gifts (id text, amount numeric, fee numeric) on commit drop;
  delete from pg_temp.fee_gifts;
  insert into pg_temp.fee_gifts
  select d.id, d.amount, d.fee from public.donations d
   where d.org_id = v_org and d.deleted_at is null and d.status in ('completed', 'collect')
     and (exists (select 1 from public.recon_match_items i where i.org_id = v_org and i.match_id = m.id and i.item_type = 'donation' and i.item_id = d.id)
       or exists (select 1 from public.recon_match_items i where i.org_id = v_org and i.match_id = m.id and i.item_type = 'donation_split' and i.item_id = d.split_group_id));
  select count(*), sum(amount) into v_n, v_sum from pg_temp.fee_gifts;
  if coalesce(v_n, 0) = 0 or coalesce(v_sum, 0) <= 0 then raise exception 'This match has no gifts to put the fee on'; end if;

  v_total := -m.difference;   -- what the processor kept: the gifts less the deposit
  for r in select * from pg_temp.fee_gifts order by amount, id loop
    v_i := v_i + 1;
    v_fee := case when v_i < v_n then ceil(v_total * r.amount / v_sum * 100) / 100 else v_total - v_given end;
    if v_fee < 0 or v_fee > r.amount then raise exception 'The fee doesn''t fit on gift % (its share would be %)', r.id, v_fee; end if;
    v_given := v_given + v_fee;
    update public.donations set manual_fee = v_fee, fee = v_fee, net_donation = amount - v_fee where org_id = v_org and id = r.id;
    perform public.write_activity(v_org, 'fee_difference_applied', 'donations', r.id, null,
      jsonb_build_object('match', m.id, 'fee_before', r.fee, 'fee', v_fee));
  end loop;

  update public.recon_matches set fee_applied_at = now(), fee_applied_by = public.current_email(),
         note = concat_ws(' · ', nullif(note, ''), 'Real fee of ' || to_char(v_total, 'FM999,990.00') || ' applied to ' || v_n || ' gift' || case when v_n = 1 then '' else 's' end)
   where org_id = v_org and id = m.id;
  return v_n;
end $$;
revoke execute on function public.apply_fee_difference(text) from public, anon;
grant execute on function public.apply_fee_difference(text) to authenticated;
