-- Dashboard loads slowly (Moshe Henig, 2026-11-16, "why does it take so long for the dashboard to fill in the
-- numbers?"): dashboard_stats took ~0.9 s in the database, ~0.5 s of it building every campaign's full balance
-- (campaign_summary) only to add up three pledge figures. Those are now summed straight from the pledges, with the
-- same result. The raised rules (readiness #9) are unchanged; this is the same function with that one part swapped.

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
    -- Open pledges and what's scheduled in the next 30 and 90 days, worked out straight from the pledges (the same
    -- sums campaign_summary gives per campaign, added up), instead of building every campaign's full balance first.
    select
      (select coalesce(sum(greatest(p.amount - coalesce((select sum(pp.amount) from public.pledge_payments pp
                                                           where pp.org_id = p.org_id and pp.pledge_id = p.id), 0), 0)), 0)
       from public.pledges p
       join public.campaigns c on c.org_id = p.org_id and c.id = p.campaign_id and c.deleted_at is null
       where p.deleted_at is null and p.cancelled_at is null) as pledged,
      s.s30, s.s90
    from (
      select coalesce(sum(left_due) filter (where due_date <= v_today + 30), 0) as s30, coalesce(sum(left_due), 0) as s90
      from (
        select i.due_date, greatest(i.amount - coalesce((select sum(pp.amount) from public.pledge_payments pp
                                                         where pp.org_id = i.org_id and pp.installment_id = i.id), 0), 0) as left_due
        from public.pledge_installments i
        join public.pledges p on p.org_id = i.org_id and p.id = i.pledge_id
        join public.campaigns c on c.org_id = p.org_id and c.id = p.campaign_id and c.deleted_at is null
        where not i.skipped and not i.cancelled and p.deleted_at is null and p.cancelled_at is null
          and i.due_date >= v_today and i.due_date <= v_today + 90
      ) x
    ) s
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
