-- "I just created a check and I don't see it in the Task Sheet to print" (Moshe Henig, 2026-11-11). Creating a
-- payout paid by check is creating the check; until now only a printed check (waiting for "did it print?") was a
-- task. Now a check payout with no check printed yet is a "Check To Print" task. Printing it from the task or the
-- payout clears this task and starts the "Check Not Printed" one until someone confirms it printed. A payout that
-- is deleted, cleared, changed to another method or not yet processed (scheduled) has no such task.

-- Sets the payout's "Check To Print" task from its current state: open while it needs a check printed, otherwise resolved.
create or replace function public.refresh_check_to_print(p_org uuid, p_expense text) returns void
language plpgsql security definer set search_path = '' as $$
declare e public.expenses; v_key text := 'check_to_print:' || p_expense;
begin
  select * into e from public.expenses x where x.org_id = p_org and x.id = p_expense;
  if e.id is not null and e.method = 'Check' and e.deleted_at is null and e.cleared is not true and e.processed_at is not null
     and not exists (select 1 from public.checks k where k.org_id = p_org and k.expense_id = e.id and k.status in ('outstanding','cleared')) then
    insert into public.task_items (org_id, task_key, task_type, record_id, campaign_id, amount, summary)
    values (p_org, v_key, 'check_to_print', e.id, e.campaign_id, e.amount,
            format('Check to %s: not printed yet', coalesce(nullif(trim(e.payee), ''), 'a payee still to be chosen')))
    on conflict (org_id, task_key) do update
      set resolved_at = null, campaign_id = excluded.campaign_id, amount = excluded.amount, summary = excluded.summary;
  else
    update public.task_items set resolved_at = now() where org_id = p_org and task_key = v_key and resolved_at is null;
  end if;
end $$;
revoke execute on function public.refresh_check_to_print(uuid, text) from public, anon, authenticated;

create or replace function public.check_to_print_task() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform public.refresh_check_to_print(new.org_id, new.id);
  return null;
end $$;
drop trigger if exists check_to_print_task on public.expenses;
create trigger check_to_print_task after insert or update on public.expenses
  for each row execute function public.check_to_print_task();
revoke execute on function public.check_to_print_task() from public, anon, authenticated;

-- Issuing a check takes its payout off the sheet; voiding or losing it puts the payout back to print again.
create or replace function public.check_to_print_follow_check() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform public.refresh_check_to_print(new.org_id, new.expense_id);
  return null;
end $$;
drop trigger if exists check_to_print_follow_check on public.checks;
create trigger check_to_print_follow_check after insert or update of status on public.checks
  for each row when (new.expense_id is not null) execute function public.check_to_print_follow_check();
revoke execute on function public.check_to_print_follow_check() from public, anon, authenticated;

-- Check payouts already waiting to be printed.
insert into public.task_items (org_id, task_key, task_type, record_id, campaign_id, amount, summary)
select e.org_id, 'check_to_print:' || e.id, 'check_to_print', e.id, e.campaign_id, e.amount,
       format('Check to %s: not printed yet', coalesce(nullif(trim(e.payee), ''), 'a payee still to be chosen'))
from public.expenses e
where e.method = 'Check' and e.deleted_at is null and e.cleared is not true and e.processed_at is not null
  and not exists (select 1 from public.checks k where k.org_id = e.org_id and k.expense_id = e.id and k.status in ('outstanding','cleared'))
on conflict (org_id, task_key) do nothing;
