-- Readiness #9 (2026-11-15) and Moshe's answer on #8: one definition of "raised" everywhere.
--
-- The totals disagreed because each page summed something different:
--   * Transactions summed completed and "to collect" rows at their full amount, Batch deposits included.
--   * The Dashboard summed completed rows only, Batch deposits at what was funded, checks not yet delivered included.
--   * Campaign balances (the reference) count completed rows, Batch at what was funded, and leave out checks not
--     yet delivered.
-- Now all of them use the campaign rule:
--   counted = status 'completed', and not a check that hasn't been delivered yet
--   raised  = for counted rows: a Payment's amount, a Batch deposit's funded part (the rest shows as pending)
-- Checks not yet delivered are shown on the dashboard together with open pledges, not in raised (Moshe, #8).
-- "To collect" rows aren't raised anywhere (unchanged; how that status is used is decided separately, #10).
-- The Platform page counts successful (completed) donations, as the Transactions list does by default.

drop view if exists public.transaction_list;
create view public.transaction_list with (security_invoker = true) as
select d.*,
       c.internal_name as campaign_internal,
       c.external_name as campaign_external,
       coalesce(dn.display_name, nullif(trim(d.donor_label), ''), d.name) as donor_name,
       coalesce(co.full_name, d.collector_label) as collector_name,
       s.name as source_name,
       a.name as account_name,
       (d.status = 'completed' and d.delivered = false and d.payment_method ilike '%check%') is true as undelivered_check,
       (d.status = 'completed' and not coalesce(d.delivered = false and d.payment_method ilike '%check%', false)) as counted,
       case when d.status = 'completed' and not coalesce(d.delivered = false and d.payment_method ilike '%check%', false)
            then case when d.type = 'Payment' then d.amount else coalesce(d.funded, 0) end
            else 0 end as raised
from public.donations d
left join public.campaigns  c  on c.org_id  = d.org_id and c.id  = d.campaign_id
left join public.donors     dn on dn.org_id = d.org_id and dn.id = d.donor_id
left join public.collectors co on co.org_id = d.org_id and co.id = d.collector_id
left join public.sources    s  on s.org_id  = d.org_id and s.id  = d.source
left join public.accounts   a  on a.org_id  = d.org_id and a.id  = d.account_id
where d.deleted_at is null;
revoke all on public.transaction_list from anon;
grant select on public.transaction_list to authenticated;

create or replace function public.dashboard_stats(p_from date, p_to date) returns jsonb
language plpgsql stable set search_path = '' as $function$
declare
  v_org uuid := public.current_org_id();
  v_tz text;
  v_today date;
  v_since date;
  v_result jsonb;
begin
  select s.value #>> '{}' into v_tz from public.settings s where s.org_id = v_org and s.key = 'timezone';
  v_tz := coalesce(v_tz, 'America/New_York');
  v_today := (now() at time zone v_tz)::date;
  v_since := least(p_from, date_trunc('year', v_today)::date);

  with base as (
    select d.campaign_id, d.source, d.payment_method, (d.created_at at time zone v_tz)::date as day,
           case when d.type = 'Payment' then d.amount else coalesce(d.funded, 0) end as raised,
           coalesce(d.fee, 0) as fee
    from public.donations d
    where d.status = 'completed' and d.deleted_at is null and d.created_at >= (v_since::timestamp at time zone v_tz)
      and not coalesce(d.delivered = false and d.payment_method ilike '%check%', false)
  ), ranged as (
    select * from base where day between p_from and p_to
  ), periods as (
    select jsonb_build_object(
      'today', jsonb_build_object('raised', coalesce(sum(raised) filter (where day = v_today), 0), 'fees', coalesce(sum(fee) filter (where day = v_today), 0)),
      'week',  jsonb_build_object('raised', coalesce(sum(raised) filter (where day >= v_today - extract(dow from v_today)::int), 0), 'fees', coalesce(sum(fee) filter (where day >= v_today - extract(dow from v_today)::int), 0)),
      'month', jsonb_build_object('raised', coalesce(sum(raised) filter (where day >= date_trunc('month', v_today)::date), 0), 'fees', coalesce(sum(fee) filter (where day >= date_trunc('month', v_today)::date), 0)),
      'year',  jsonb_build_object('raised', coalesce(sum(raised) filter (where day >= date_trunc('year', v_today)::date), 0), 'fees', coalesce(sum(fee) filter (where day >= date_trunc('year', v_today)::date), 0))
    ) || jsonb_build_object(
      'all', (select jsonb_build_object('raised', coalesce(sum(case when d.type = 'Payment' then d.amount else coalesce(d.funded, 0) end), 0),
                                        'fees', coalesce(sum(coalesce(d.fee, 0)), 0))
              from public.donations d where d.status = 'completed' and d.deleted_at is null
                and not coalesce(d.delivered = false and d.payment_method ilike '%check%', false))
    ) as j from base
  ), totals as (
    select coalesce(sum(s.pledged_open), 0) as pledged, coalesce(sum(s.pledge_scheduled_30), 0) as s30, coalesce(sum(s.pledge_scheduled_90), 0) as s90
    from public.campaign_summary s
  )
  select jsonb_build_object(
    'today', v_today,
    'periods', (select j from periods),
    'range', (select jsonb_build_object('raised', coalesce(sum(raised), 0), 'fees', coalesce(sum(fee), 0), 'count', count(*)) from ranged),
    'daily', (select coalesce(jsonb_agg(jsonb_build_object('day', day, 'total', total) order by day), '[]')
              from (select day, sum(raised) as total from ranged group by day) x),
    'sources', (select coalesce(jsonb_agg(jsonb_build_object('name', name, 'total', total) order by total desc), '[]')
                from (select coalesce(so.name, r.source, 'Unknown') as name, sum(r.raised) as total
                      from ranged r left join public.sources so on so.org_id = v_org and so.id = r.source
                      group by 1 order by 2 desc limit 8) x),
    'methods', (select coalesce(jsonb_agg(jsonb_build_object('name', name, 'total', total, 'count', n) order by total desc), '[]')
                from (select coalesce(nullif(trim(r.payment_method), ''), 'Not recorded') as name, sum(r.raised) as total, count(*) as n
                      from ranged r group by 1 having sum(r.raised) > 0 order by 2 desc) x),
    'top_campaigns', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'total', total) order by total desc), '[]')
                      from (select c.id, c.internal_name as name, sum(r.raised) as total
                            from ranged r join public.campaigns c on c.org_id = v_org and c.id = r.campaign_id
                            group by c.id, c.internal_name order by 3 desc limit 8) x),
    'top_fundraisers', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'total', total) order by total desc), '[]')
                        from (select m.id, m.full_name as name, sum(r.raised) as total
                              from ranged r
                              join public.campaigns c on c.org_id = v_org and c.id = r.campaign_id
                              join public.managers m on m.org_id = v_org and m.id = c.manager_id
                              group by m.id, m.full_name order by 3 desc limit 8) x),
    'pledged', (select pledged from totals),
    'scheduled_30', (select s30 from totals),
    'scheduled_90', (select s90 from totals),
    -- Checks recorded but not delivered yet: shown with open pledges, not in raised (Moshe Henig, #8).
    'undelivered', (select jsonb_build_object('amount', coalesce(sum(d.amount), 0), 'count', count(*))
                    from public.donations d
                    where d.status = 'completed' and d.deleted_at is null and d.delivered = false and d.payment_method ilike '%check%')
  ) into v_result;
  return v_result;
end $function$;

create or replace function public.platform_list_orgs()
returns table (id uuid, slug text, name text, status text, created_at timestamptz, hostnames text[],
               member_count bigint, campaign_count bigint, donor_count bigint, donation_count bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.require_platform_owner();
  return query
    select o.id, o.slug, o.name, o.status, o.created_at,
           (select coalesce(array_agg(d.hostname order by d.hostname), '{}') from public.org_domains d where d.org_id = o.id),
           (select count(*) from public.org_members m where m.org_id = o.id),
           (select count(*) from public.campaigns c where c.org_id = o.id and c.deleted_at is null),
           (select count(*) from public.donors dn where dn.org_id = o.id and dn.deleted_at is null),
           -- Successful donations, as the Transactions list counts them by default (readiness #9).
           (select count(*) from public.donations dd where dd.org_id = o.id and dd.deleted_at is null and dd.status = 'completed')
    from public.organizations o
    order by o.name;
end $$;
