-- Checks (Moshe Henig, 2026-11-11): a check that hasn't been confirmed printed is a task on the Task Sheet. After the
-- check opens to print, the app asks whether it printed; yes marks it printed and clears the task, no leaves it there.
-- Voiding or losing a check also clears it. Checks issued before today count as printed.

alter table public.checks add column if not exists printed_at timestamptz;
alter table public.checks add column if not exists printed_by text;
update public.checks set printed_at = issued_at, printed_by = issued_by where printed_at is null;

create or replace function public.issue_check(p_payout text, p_account text, p_memo text default null)
returns table (check_id text, check_number integer)
language plpgsql security definer set search_path = '' as $function$
declare
  v_org uuid := public.current_org_id();
  e public.expenses;
  s public.account_check_settings;
  v_id text;
begin
  perform public.require_admin();
  select * into e from public.expenses x where x.org_id = v_org and x.id = p_payout and x.deleted_at is null for update;
  if e.id is null then raise exception 'Payout not found'; end if;
  if nullif(trim(e.payee), '') is null then raise exception 'Choose who the check is to first'; end if;
  if exists (select 1 from public.checks k where k.org_id = v_org and k.expense_id = e.id and k.status in ('outstanding','cleared')) then
    raise exception 'This payout already has a check. Void it first to print another';
  end if;
  select * into s from public.account_check_settings x where x.org_id = v_org and x.account_id = p_account for update;
  if s.routing_number is null or s.account_number is null or s.next_check_number is null then
    raise exception 'Set this account''s routing number, account number and starting check number first, under Accounts';
  end if;
  insert into public.checks (org_id, account_id, check_number, expense_id, payee, amount, memo, check_date)
  values (v_org, p_account, s.next_check_number, e.id, trim(e.payee), e.amount, coalesce(nullif(trim(p_memo), ''), e.memo),
          public.org_today())
  returning id into v_id;
  update public.account_check_settings x set next_check_number = s.next_check_number + 1
  where x.org_id = v_org and x.account_id = p_account;
  update public.expenses x set check_number = s.next_check_number::text, account_id = p_account, method = 'Check', cleared = false
  where x.org_id = v_org and x.id = e.id;
  -- On the Task Sheet until someone confirms it printed.
  insert into public.task_items (org_id, task_key, task_type, record_id, campaign_id, amount, summary)
  values (v_org, 'check_unprinted:' || v_id, 'check_unprinted', v_id, e.campaign_id, e.amount,
          format('Check #%s to %s: not confirmed printed', s.next_check_number, trim(e.payee)))
  on conflict (org_id, task_key) do update set resolved_at = null;
  return query select v_id, s.next_check_number;
end $function$;

create or replace function public.mark_check_printed(p_check text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  perform public.require_admin();
  update public.checks set printed_at = coalesce(printed_at, now()), printed_by = coalesce(printed_by, public.current_email())
  where org_id = v_org and id = p_check;
  if not found then raise exception 'Check not found'; end if;
  update public.task_items set resolved_at = now() where org_id = v_org and task_key = 'check_unprinted:' || p_check and resolved_at is null;
end $$;

create or replace function public.check_unprinted_task_off() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status in ('voided','lost') then
    update public.task_items set resolved_at = now() where org_id = new.org_id and task_key = 'check_unprinted:' || new.id and resolved_at is null;
  end if;
  return new;
end $$;
drop trigger if exists check_unprinted_task_off on public.checks;
create trigger check_unprinted_task_off after update of status on public.checks
  for each row execute function public.check_unprinted_task_off();

revoke execute on function public.mark_check_printed(text) from public, anon;
grant execute on function public.mark_check_printed(text) to authenticated;
revoke execute on function public.check_unprinted_task_off() from public, anon, authenticated;
