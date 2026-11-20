-- Readiness #19 (2026-11-15): an "Available to pay out" figure, for display only. The balance counts card gifts the
-- processor hasn't paid out yet and checks the bank hasn't cleared. Available = the balance, minus card gifts from
-- the last few days (the organization's card hold, 3 days unless set), minus checks recorded in the last 30 days
-- that aren't matched to a bank line yet. Disputed gifts are already out of the balance (readiness #17). Nothing
-- here blocks or changes a payout (that rule is held, #18).

alter table public.organizations add column if not exists payout_hold_days integer not null default 3
  check (payout_hold_days between 0 and 60);

-- Runs as the person asking: they see the figure for campaigns they may see, from gifts they may see.
create or replace function public.campaign_available(p_campaign text)
returns table (balance numeric, card_hold numeric, checks_uncleared numeric, available numeric, hold_days integer)
language sql stable set search_path = '' as $$
  with recursive fam as (
    -- The campaign and the teams that share its balance (their money is in its balance).
    select c.org_id, c.id from public.campaigns c where c.org_id = public.current_org_id() and c.id = p_campaign
    union all
    select k.org_id, k.id from public.campaigns k join fam on k.org_id = fam.org_id and k.parent_campaign_id = fam.id
     where k.balance_mode = 'shared' and k.deleted_at is null
  ), o as (
    select coalesce((select g.payout_hold_days from public.organizations g where g.id = public.current_org_id()), 3) as days
  ), g as (
    select d.*, (d.status = 'completed' and not coalesce(d.delivered = false and d.payment_method ilike '%check%', false)) as counted
    from public.donations d join fam on fam.org_id = d.org_id and fam.id = d.campaign_id
    where d.deleted_at is null and d.status = 'completed'
  ), x as (
    select
      coalesce(sum(case when g.type = 'Payment' then g.amount else coalesce(g.funded, 0) end - coalesce(g.fee, 0))
        filter (where g.counted and g.created_at >= now() - make_interval(days => (select days from o))
                and (public.fee_processor(g.source, g.donary_id, g.gateway_id) in ('sola', 'elevon')
                     or exists (select 1 from public.payment_methods m where m.org_id = g.org_id and lower(m.name) = lower(g.payment_method) and m.category = 'Gateway'))), 0) as card_hold,
      coalesce(sum(g.amount - coalesce(g.fee, 0))
        filter (where g.counted and g.payment_method ilike '%check%' and g.created_at >= now() - interval '30 days'
                and not exists (select 1 from public.recon_match_items mi where mi.org_id = g.org_id and mi.item_type = 'donation' and mi.item_id = g.id)), 0) as checks_uncleared
    from g
  )
  select s.balance, x.card_hold, x.checks_uncleared, s.balance - x.card_hold - x.checks_uncleared, (select days from o)
  from public.campaign_summary s, x
  where s.id = p_campaign
$$;
revoke execute on function public.campaign_available(text) from public, anon;
grant execute on function public.campaign_available(text) to authenticated;
