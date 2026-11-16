-- Moshe #20 (approved 2026-11-15): once a payout's check is confirmed printed ("Yes, it printed", or "It already
-- printed") or emailed, the payout's amount and payee are locked. Void the check to change them (a voided check no
-- longer locks it). Payouts whose check hasn't printed yet, and payouts with no check, stay editable. Merging two
-- payees still moves their payouts to the payee kept.

create or replace function public.printed_payout_lock() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_num integer;
begin
  if new.amount is not distinct from old.amount and new.payee_id is not distinct from old.payee_id
     and new.payee is not distinct from old.payee then
    return new;
  end if;
  if coalesce(current_setting('oizer.payee_merge', true), '') = 'on'
     and new.amount is not distinct from old.amount then
    return new;
  end if;
  select k.check_number into v_num from public.checks k
   where k.org_id = old.org_id and k.expense_id = old.id and k.status in ('outstanding', 'cleared')
     and (k.printed_at is not null or k.emailed_at is not null)
   order by k.issued_at desc limit 1;
  if v_num is not null then
    raise exception 'Check #% for this payout has printed, so its amount and payee are locked. Void the check to change them.', v_num
      using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke execute on function public.printed_payout_lock() from public, anon, authenticated;

drop trigger if exists printed_payout_lock on public.expenses;
-- Runs after payout_rules, which fills the payee's name from the payee chosen.
create trigger printed_payout_lock before update on public.expenses
  for each row execute function public.printed_payout_lock();

-- Merging payees marks itself so the lock lets the payee move to the one kept.
do $$
declare v_def text; v_new text;
begin
  select pg_get_functiondef(p.oid) into v_def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'merge_payees';
  v_new := replace(v_def, 'update public.expenses set payee_id = k.id where org_id = v_org and payee_id = a.id;',
    'perform set_config(''oizer.payee_merge'', ''on'', true);
  update public.expenses set payee_id = k.id where org_id = v_org and payee_id = a.id;
  perform set_config(''oizer.payee_merge'', '''', true);');
  if v_new = v_def then raise exception 'merge_payees: payout move not found'; end if;
  execute v_new;
end $$;
