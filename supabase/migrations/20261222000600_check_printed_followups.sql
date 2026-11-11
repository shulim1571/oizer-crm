-- Check printing follow-ups (Moshe Henig, 2026-11-11: "I don't see the check in the task sheet"). Check #5010's task
-- was created when it was issued and cleared 13 seconds later by "Yes, it printed"; two seconds after that the payout
-- form, still open with an empty check number, was saved and wiped the payout's check number.
--   * A payout keeps the number of its issued check: a stale form can't blank or change it.
--   * The register shows whether each check printed, and who said so.
--   * "Mark not printed" puts a check back on the Task Sheet (to undo a Yes given too soon).

create or replace function public.keep_issued_check_number() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_n integer;
begin
  select k.check_number into v_n from public.checks k
  where k.org_id = new.org_id and k.expense_id = new.id and k.status in ('outstanding','cleared')
  order by k.issued_at desc limit 1;
  if v_n is not null then new.check_number := v_n::text; end if;
  return new;
end $$;
drop trigger if exists keep_issued_check_number on public.expenses;
create trigger keep_issued_check_number before update on public.expenses
  for each row execute function public.keep_issued_check_number();
revoke execute on function public.keep_issued_check_number() from public, anon, authenticated;

-- The payout whose check number was wiped gets it back (the trigger above fills it in).
update public.expenses e set check_number = k.check_number::text
from public.checks k
where k.org_id = e.org_id and k.expense_id = e.id and k.status in ('outstanding','cleared')
  and e.check_number is distinct from k.check_number::text;

create or replace function public.mark_check_unprinted(p_check text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); k public.checks;
begin
  perform public.require_admin();
  select * into k from public.checks where org_id = v_org and id = p_check;
  if k.id is null then raise exception 'Check not found'; end if;
  if k.status <> 'outstanding' then raise exception 'Only an outstanding check can go back to the Task Sheet'; end if;
  update public.checks set printed_at = null, printed_by = null where org_id = v_org and id = p_check;
  insert into public.task_items (org_id, task_key, task_type, record_id, campaign_id, amount, summary)
  select v_org, 'check_unprinted:' || k.id, 'check_unprinted', k.id, e.campaign_id, k.amount,
         format('Check #%s to %s: not confirmed printed', k.check_number, k.payee)
  from (select 1) one left join public.expenses e on e.org_id = v_org and e.id = k.expense_id
  on conflict (org_id, task_key) do update set resolved_at = null, created_at = now();
end $$;
revoke execute on function public.mark_check_unprinted(text) from public, anon;
grant execute on function public.mark_check_unprinted(text) to authenticated;

create or replace view public.check_register with (security_invoker = true) as
SELECT k.id,
    k.org_id,
    k.account_id,
    k.check_number,
    k.expense_id,
    k.payee,
    k.amount,
    k.memo,
    k.check_date,
    k.status,
    k.status_reason,
    k.status_by,
    k.status_at,
    k.issued_by,
    k.issued_at,
    a.name AS account_name,
    e.campaign_id,
    c.internal_name AS campaign_name,
    e.payee_id,
        CASE
            WHEN (k.status = 'outstanding'::text) THEN (org_today() - k.check_date)
            ELSE NULL::integer
        END AS days_outstanding,
    k.printed_at,
    k.printed_by
   FROM (((checks k
     JOIN accounts a ON (((a.org_id = k.org_id) AND (a.id = k.account_id))))
     LEFT JOIN expenses e ON (((e.org_id = k.org_id) AND (e.id = k.expense_id))))
     LEFT JOIN campaigns c ON (((c.org_id = e.org_id) AND (c.id = e.campaign_id))));
