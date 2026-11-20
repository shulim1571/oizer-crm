-- AB Charity (Moshe, 2026-11-20): a payment method, and its payouts matched to bank deposits by amount and date.
-- AB Charity has no gift-level export, so a payout is total-only: the inbox reads its "Payouts Are On The Way"
-- email as a deposit with no lines, and suggests the bank line with that amount a few days after. Nothing posts.

-- The method, for every organization that doesn't have it yet: a charity-fund platform like OJC and Pledger (no
-- receipts, as for other DAF gifts), with no fee rule until an admin sets one under Methods & Fees.
insert into public.payment_methods (org_id, name, category, fee_type, receipt_allowed, is_custom)
select o.id, 'AB Charity', 'DAF', 'none', false, false
from public.organizations o
where not exists (select 1 from public.payment_methods m where m.org_id = o.id and lower(m.name) = 'ab charity');

-- New organizations get it too.
do $$
declare v_def text; v_new text;
begin
  select pg_get_functiondef('public.seed_payment_methods'::regproc) into v_def;
  v_new := replace(v_def, $s$('Pledger', 'DAF', false), ('Matbia', 'DAF', false),$s$, $s$('Pledger', 'DAF', false), ('Matbia', 'DAF', false), ('AB Charity', 'DAF', false),$s$);
  if v_new = v_def then raise exception 'seed_payment_methods: DAF list not found'; end if;
  execute v_new;
end $$;

-- AB Charity payouts as deposits.
alter table public.deposits drop constraint if exists deposits_kind_check;
alter table public.deposits add constraint deposits_kind_check check (kind in ('ojc_ach', 'pledger_ach', 'ojc_submission', 'pledger_batch', 'bank_check_deposit', 'ab_charity'));

do $$
declare v_def text; v_new text;
begin
  select pg_get_functiondef('public.inbox_record_deposit'::regproc) into v_def;
  v_new := replace(v_def, $s$v_kind in ('ojc_ach', 'pledger_ach', 'bank_check_deposit')$s$, $s$v_kind in ('ojc_ach', 'pledger_ach', 'bank_check_deposit', 'ab_charity')$s$);
  if v_new = v_def then raise exception 'inbox_record_deposit: bank suggestion not found'; end if;
  execute v_new;

  select pg_get_functiondef('public.deposit_task_sync'::regproc) into v_def;
  v_new := replace(v_def, $s$when 'bank_check_deposit' then 'check deposit'$s$, $s$when 'bank_check_deposit' then 'check deposit' when 'ab_charity' then 'payout'$s$);
  if v_new = v_def then raise exception 'deposit_task_sync: kind words not found'; end if;
  execute v_new;
end $$;
