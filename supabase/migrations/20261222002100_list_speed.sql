-- List speed (Moshe Henig, 2026-11-12: "the Campaigns list has to load faster, and so do all the other lists").
-- campaign_summary (Campaigns list, campaign pages, Fundraisers list via manager_summary, payouts and transfers
-- pickers) took about 1.5 s, and 1.3 s of it was these two helpers. Each re-checked the organization, the admin role
-- and the person's campaigns once per expense or transfer row. Those answers are the same for the whole request, so
-- each check is now written as (select ...), which the database works out once. Same rows, same totals, same access.
create or replace function public.campaign_expense_totals()
returns table (org_id uuid, campaign_id text, expenses numeric)
language sql stable security definer set search_path = '' as $$
  select x.org_id, x.campaign_id, sum(x.amount)
  from public.expenses x
  where x.deleted_at is null
    and ((select auth.uid()) is null
         or (x.org_id = (select public.current_org_id())
             and ((select public.is_admin())
                  or x.campaign_id = any((select public.my_campaign_ids())::text[])
                  or x.campaign_id = any((select public.my_guest_campaign_ids())::text[]))))
  group by x.org_id, x.campaign_id
$$;

create or replace function public.campaign_transfer_totals()
returns table (org_id uuid, campaign_id text, amount_in numeric, amount_out numeric)
language sql stable security definer set search_path = '' as $$
  select x.org_id, x.campaign_id, sum(x.amount_in), sum(x.amount_out)
  from (
    select t.org_id, t.to_campaign_id as campaign_id, t.amount as amount_in, 0::numeric as amount_out
    from public.transfers t where t.deleted_at is null and t.to_campaign_id is not null
    union all
    select t.org_id, t.from_campaign_id, 0, t.amount
    from public.transfers t where t.deleted_at is null and t.from_campaign_id is not null
  ) x
  where (select auth.uid()) is null
     or (x.org_id = (select public.current_org_id())
         and ((select public.is_admin())
              or x.campaign_id = any((select public.my_campaign_ids())::text[])
              or x.campaign_id = any((select public.my_guest_campaign_ids())::text[])))
  group by x.org_id, x.campaign_id
$$;
