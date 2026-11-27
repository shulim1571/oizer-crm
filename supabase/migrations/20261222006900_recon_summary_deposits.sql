-- Readiness #32 (2026-11-15): the reconciliation summary per account also shows book deposits not matched to the
-- bank yet (deposits in transit), counted since the last sign-off, or over the last 60 days before any sign-off
-- (an account never reconciled would otherwise count its whole history). The return columns change, so the
-- function is recreated with its same access.
drop function if exists public.bank_reconciliation_summary();
CREATE OR REPLACE FUNCTION public.bank_reconciliation_summary()
 RETURNS TABLE(account_id text, account_name text, unmatched_lines bigint, unmatched_total numeric, last_line_date date, locked_through date, last_statement_balance numeric, outstanding_checks bigint, outstanding_checks_total numeric,
         deposits_unmatched bigint, deposits_unmatched_total numeric, deposits_since date)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
declare v_org uuid := public.current_org_id();
begin
  perform public.require_mfa();
  perform public.require_admin();
  return query
  select a.id, a.name,
         (select count(*) from public.bank_lines l where l.org_id = v_org and l.account_id = a.id and l.match_id is null),
         (select coalesce(sum(l.amount), 0) from public.bank_lines l where l.org_id = v_org and l.account_id = a.id and l.match_id is null),
         (select max(l.posted_date) from public.bank_lines l where l.org_id = v_org and l.account_id = a.id),
         public.bank_locked_through(v_org, a.id),
         (select p.statement_balance from public.bank_periods p where p.org_id = v_org and p.account_id = a.id and p.status = 'signed'
          order by p.period_end desc limit 1),
         (select count(*) from public.checks k where k.org_id = v_org and k.account_id = a.id and k.status = 'outstanding'),
         (select coalesce(sum(k.amount), 0) from public.checks k where k.org_id = v_org and k.account_id = a.id and k.status = 'outstanding'),
         u.n, u.total, u.since
  from public.accounts a
  -- Book deposits not matched to the bank yet, since the last sign-off (or the last 60 days before any sign-off).
  left join lateral (
    select count(d.id) as n, coalesce(sum(d.amount), 0) as total, s.since
    from (select coalesce(public.bank_locked_through(v_org, a.id) + 1, public.org_today() - 60) as since) s
    left join public.donations d
      on d.org_id = v_org and d.account_id = a.id and d.deleted_at is null and d.status in ('completed', 'collect') and d.amount > 0
     and d.created_at >= (s.since::timestamp at time zone public.org_zone(v_org))
     and not coalesce(d.status = 'completed' and d.delivered = false and d.payment_method ilike '%check%', false)
     and not exists (select 1 from public.recon_match_items mi where mi.org_id = v_org
                       and ((mi.item_type = 'donation' and mi.item_id = d.id) or (mi.item_type = 'donation_split' and mi.item_id = d.split_group_id)))
     and not exists (select 1 from public.recon_exclusions x where x.org_id = v_org
                       and ((x.item_type = 'donation' and x.item_id = d.id) or (x.item_type = 'donation_split' and x.item_id = d.split_group_id)))
    group by s.since
  ) u on true
  where a.org_id = v_org and a.deleted_at is null
  order by a.name;
end $function$
;
revoke execute on function public.bank_reconciliation_summary() from public, anon;
grant execute on function public.bank_reconciliation_summary() to authenticated, service_role;
