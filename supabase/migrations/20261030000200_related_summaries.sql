-- Totals for the reverse side of each reference: source -> donations,
-- account -> donations + expenses, manager -> campaigns.

create or replace view public.source_summary with (security_invoker = true) as
select s.*,
       coalesce(d.donation_count, 0) as donation_count,
       coalesce(d.total_amount, 0)   as total_amount,
       coalesce(d.total_fees, 0)     as total_fees,
       d.last_donation_at
from public.sources s
left join (
  select source,
         count(*)                                                as donation_count,
         sum(amount)                                             as total_amount,
         sum(coalesce(fee, 0))                                   as total_fees,
         max(created_at)                                         as last_donation_at
  from public.donations
  where type <> 'Voided'
  group by source
) d on d.source = s.id;

create or replace view public.account_summary with (security_invoker = true) as
select a.*,
       coalesce(d.donation_count, 0) as donation_count,
       coalesce(d.donations_total, 0) as donations_total,
       coalesce(e.expense_count, 0)  as expense_count,
       coalesce(e.expenses_total, 0) as expenses_total,
       coalesce(e.uncleared_total, 0) as uncleared_total
from public.accounts a
left join (
  select account_id, count(*) as donation_count, sum(amount) as donations_total
  from public.donations where type <> 'Voided' group by account_id
) d on d.account_id = a.id
left join (
  select account_id,
         count(*)                                                as expense_count,
         sum(amount)                                             as expenses_total,
         sum(amount) filter (where method = 'Check' and cleared is not true) as uncleared_total
  from public.expenses group by account_id
) e on e.account_id = a.id;

-- Counts both campaigns a person manages and ones where they are a sub-manager.
create or replace view public.manager_summary with (security_invoker = true) as
select m.*,
       count(c.id)                                     as campaign_count,
       count(c.id) filter (where c.archived_at is null) as active_count,
       coalesce(sum(c.raised), 0)                      as raised,
       coalesce(sum(c.balance), 0)                     as balance
from public.managers m
left join public.campaign_summary c
  on c.manager_id = m.id or m.id = any(c.sub_manager_ids)
group by m.id;

grant select on public.source_summary, public.account_summary, public.manager_summary to authenticated;
