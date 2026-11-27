-- Readiness #26 (2026-11-15), with #9's "check that the totals agree": a nightly check of the books.
--
-- integrity_checks(org) runs the checks from the readiness review (code-data-findings section 5: Q2-Q6, Q8-Q14,
-- Q18), plus a tie-out of each campaign's raised figure against its gifts. Every night (and on "Check now") each
-- organization gets a run: kept in integrity_runs, shown as the dashboard's Books health badge, and every check that
-- finds something is a Task Sheet item, which clears itself once the check comes back clean. Read-only: it changes
-- no money.
--
-- Imported history is checked too; its known gaps (no bank account, no fee) will show until they're dealt with.
-- Its Donary field isn't a payment number, so imported rows aren't counted as duplicate Donary payments.

create table if not exists public.integrity_runs (
  id      bigint generated always as identity primary key,
  org_id  uuid not null references public.organizations(id),
  ran_at  timestamptz not null default now(),
  ok      boolean not null,
  results jsonb not null
);
create index if not exists integrity_runs_org on public.integrity_runs (org_id, ran_at desc);
alter table public.integrity_runs enable row level security;
revoke all on public.integrity_runs from public, anon, authenticated;
grant select on public.integrity_runs to authenticated;
drop policy if exists admin_read on public.integrity_runs;
create policy admin_read on public.integrity_runs for select to authenticated
  using (org_id = (select public.current_org_id()) and (select public.is_admin()));

create or replace function public.integrity_checks(p_org uuid)
returns table (check_key text, label text, n bigint, amount numeric)
language sql stable security definer set search_path = '' as $$
  with d as (select * from public.donations where org_id = p_org and deleted_at is null)
  select 'orphan_campaign', 'Gifts on a campaign that is missing or deleted', count(*), sum(d.amount)
    from d left join public.campaigns c on c.org_id = d.org_id and c.id = d.campaign_id
   where d.campaign_id is not null and (c.id is null or c.deleted_at is not null)
  union all
  select 'duplicate_refs', 'Processor references recorded more than once', count(*), null from (
    select gateway_id from d where gateway_id is not null and status <> 'failed' and split_group_id is null and refund_of is null
      and not coalesce(possible_duplicate and duplicate_reviewed_by is null, false)
     group by gateway_id having count(*) > 1
    union all
    select donary_id from d where donary_id is not null and status <> 'failed' and split_group_id is null and refund_of is null and id not like 'AS-%'
     group by donary_id having count(*) > 1) x
  union all
  select 'net_mismatch', 'Net isn''t the amount less the fee', count(*), sum(d.net_donation - (d.amount - coalesce(d.fee, 0)))
    from d where status in ('completed', 'collect') and net_donation is distinct from amount - coalesce(fee, 0)
  union all
  select 'fee_missing', 'Completed gifts with a payment method but no fee', count(*), sum(d.amount)
    from d where status in ('completed', 'collect') and fee is null and payment_method is not null
  union all
  select 'fee_out_of_range', 'Fees below $0 or above the gift, or gifts of $0 or less', count(*), null
    from d where status not in ('failed', 'voided') and refund_of is null and (fee < 0 or fee > amount or amount <= 0)
  union all
  select 'batch_mismatch', 'Batch deposits whose funded and pending parts don''t add up to the total', count(*), sum(d.amount)
    from d where type = 'Batch' and status in ('completed', 'collect') and coalesce(funded, 0) + coalesce(batch_pending, 0) <> amount
  union all
  select 'negative_balance', 'Campaigns below zero', count(*), sum(s.balance)
    from public.campaign_summary s where s.org_id = p_org and s.pool_id is null and s.balance < 0
  union all
  select 'dead_pledge_payments', 'Pledge payments made by a gift that no longer counts', count(*), sum(pp.amount)
    from public.pledge_payments pp join public.donations g on g.org_id = pp.org_id and g.id = pp.donation_id
   where pp.org_id = p_org and (g.deleted_at is not null or g.status not in ('completed', 'collect', 'disputed'))
  union all
  select 'overfunded_vouchers', 'Vouchers funded beyond their face value', count(*), sum(x.over) from (
    select v.id, sum(g.amount) - v.face_value as over
      from public.vouchers v join d g on g.voucher_id = v.id and g.status in ('completed', 'collect')
     where v.org_id = p_org group by v.id, v.face_value having sum(g.amount) > v.face_value) x
  union all
  select 'no_account', 'Completed gifts with no bank account (they can''t be reconciled)', count(*), sum(d.amount)
    from d where status in ('completed', 'collect') and account_id is null
  union all
  select 'check_amount_mismatch', 'Payouts whose check is for a different amount', count(*), sum(e.amount - k.amount)
    from public.expenses e join public.checks k on k.org_id = e.org_id and k.expense_id = e.id
   where e.org_id = p_org and e.deleted_at is null and k.status in ('outstanding', 'cleared') and k.amount <> e.amount
  union all
  select 'recon_changed', 'Reconciled items changed or removed after matching', count(*), null
    from public.recon_match_items mi
    left join public.donations g on mi.item_type = 'donation' and g.org_id = mi.org_id and g.id = mi.item_id
    left join public.expenses e on mi.item_type = 'payout' and e.org_id = mi.org_id and e.id = mi.item_id
    left join lateral (select sum(p.amount) as total, bool_or(p.deleted_at is not null) as gone from public.donations p
                        where mi.item_type = 'donation_split' and p.org_id = mi.org_id and p.split_group_id = mi.item_id) sp on true
   where mi.org_id = p_org
     and ((mi.item_type = 'donation' and (g.id is null or g.deleted_at is not null or g.amount <> mi.amount))
       or (mi.item_type = 'payout' and (e.id is null or e.deleted_at is not null or -e.amount <> mi.amount))
       or (mi.item_type = 'donation_split' and (sp.total is null or sp.gone or sp.total <> mi.amount)))
  union all
  select 'refunds_as_voids', 'Processor refunds recorded as voids (from before refunds were kept as refunds)', count(*), sum(d.amount)
    from d where status = 'voided' and reversal_reason ilike 'Voided at % (sent by Make)'
  union all
  -- Readiness #9: a campaign's raised (less transfers in) must equal its gifts under the raised rule.
  select 'raised_tieout', 'Campaigns whose raised figure doesn''t match their gifts', count(*), sum(x.diff) from (
    select s.id, (s.raised - coalesce(t.amount_in, 0)) - coalesce(r.raw, 0) as diff
      from public.campaign_summary s
      left join public.campaign_transfer_totals() t on t.org_id = s.org_id and t.campaign_id = s.id
      left join lateral (
        select sum(case when g.type = 'Payment' then g.amount else coalesce(g.funded, 0) end) as raw
          from public.donations g join public.campaigns c on c.org_id = g.org_id and c.id = g.campaign_id
         where g.org_id = s.org_id and g.deleted_at is null and g.status = 'completed'
           and not coalesce(g.delivered = false and g.payment_method ilike '%check%', false)
           and (c.id = s.id or (c.balance_mode = 'shared' and c.parent_campaign_id = s.id))) r on true
     where s.org_id = p_org and s.pool_id is null) x
   where abs(x.diff) >= 0.01
$$;
revoke execute on function public.integrity_checks(uuid) from public, anon, authenticated;

-- One run for an organization: kept, and its findings put on (or taken off) the Task Sheet.
create or replace function public.run_integrity(p_org uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_results jsonb; v_ok boolean;
begin
  select coalesce(jsonb_agg(jsonb_build_object('key', c.check_key, 'label', c.label, 'n', c.n, 'amount', c.amount) order by c.check_key), '[]'),
         coalesce(bool_and(c.n = 0), true)
    into v_results, v_ok
    from public.integrity_checks(p_org) c;
  insert into public.integrity_runs (org_id, ok, results) values (p_org, v_ok, v_results);
  insert into public.task_items (org_id, task_key, task_type, amount, summary, detail)
  select p_org, 'integrity:' || (r ->> 'key'), 'integrity', nullif(r ->> 'amount', '')::numeric,
         'Books check: ' || (r ->> 'label') || ' (' || (r ->> 'n') || ')', r
    from jsonb_array_elements(v_results) r where (r ->> 'n')::bigint > 0
  on conflict (org_id, task_key) do update set resolved_at = null, summary = excluded.summary, amount = excluded.amount, detail = excluded.detail;
  update public.task_items t set resolved_at = now()
   where t.org_id = p_org and t.task_type = 'integrity' and t.resolved_at is null
     and not exists (select 1 from jsonb_array_elements(v_results) r where 'integrity:' || (r ->> 'key') = t.task_key and (r ->> 'n')::bigint > 0);
  return jsonb_build_object('ok', v_ok, 'results', v_results);
end $$;
revoke execute on function public.run_integrity(uuid) from public, anon, authenticated;

-- "Check now", for an admin.
create or replace function public.check_books_now() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_admin();
  return public.run_integrity(public.current_org_id());
end $$;
revoke execute on function public.check_books_now() from public, anon;
grant execute on function public.check_books_now() to authenticated;

-- The nightly job.
create or replace function public.run_job(p_job text) returns void
language plpgsql security definer set search_path = '' as $function$
declare v_id bigint; r record;
begin
  insert into public.job_runs (job) values (p_job) returning id into v_id;
  begin
    case p_job
      when 'heartbeat' then null;
      when 'post_dated' then perform public.clear_post_dated();
      when 'pledge_schedules' then perform public.extend_open_pledges();
      when 'integrity' then
        for r in select id from public.organizations where status = 'active' loop perform public.run_integrity(r.id); end loop;
      else raise exception 'Unknown job %', p_job;
    end case;
    update public.job_runs set finished_at = now(), ok = true where id = v_id;
  exception when others then
    update public.job_runs set finished_at = now(), ok = false, error = sqlerrm where id = v_id;
  end;
end $function$;

-- Every night at 7:20 UTC: 2:20 AM in New York in winter, 3:20 AM in summer.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    perform cron.schedule('integrity', '20 7 * * *', $c$select public.run_job('integrity')$c$);
  end if;
end $$;
