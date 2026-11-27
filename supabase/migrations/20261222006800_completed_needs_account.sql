-- Readiness #31 (2026-11-15): a gift with no bank account can never be matched to the bank. Every gift is routed to
-- its campaign's account, else its payment method's, else the organization's default account (Accounts, "Set as
-- default"); none had gone without one on live data. Now a completed or to-collect gift always gets one: when
-- nothing applies (no default set, as in a brand-new organization), it goes to the organization's "Clearing
-- (unassigned)" account, made the first time it's needed. The nightly books check (readiness #26) lists gifts sitting
-- there, so they're moved to a real account.

create or replace function public.clearing_account(p_org uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare v_id text;
begin
  select a.id into v_id from public.accounts a where a.org_id = p_org and a.name = 'Clearing (unassigned)' and a.deleted_at is null limit 1;
  if v_id is null then
    insert into public.accounts (org_id, id, name, notes)
    values (p_org, 'clearing-' || public.short_id(), 'Clearing (unassigned)', 'Gifts with no campaign, payment method or default account to go to. Move them to a real account.')
    returning id into v_id;
  end if;
  return v_id;
end $$;
revoke execute on function public.clearing_account(uuid) from public, anon, authenticated;

create or replace function public.require_donation_account() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.deleted_at is null and new.status in ('completed', 'collect') and new.account_id is null then
    new.account_id := coalesce(public.route_account(new.org_id, new.campaign_id, new.payment_method), public.clearing_account(new.org_id));
  end if;
  return new;
end $$;
revoke execute on function public.require_donation_account() from public, anon, authenticated;
drop trigger if exists zz_require_account on public.donations;
create trigger zz_require_account before insert or update of status, account_id, deleted_at on public.donations
  for each row execute function public.require_donation_account();

-- The nightly books check lists gifts in the clearing account.
do $$
declare v_def text; v_new text;
begin
  select pg_get_functiondef(p.oid) into v_def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'integrity_checks';
  v_new := replace(v_def, $s$  select 'no_account', 'Completed gifts with no bank account (they can''t be reconciled)', count(*), sum(d.amount)
    from d where status in ('completed', 'collect') and account_id is null$s$,
    $s$  select 'no_account', 'Completed gifts with no real bank account (none, or the Clearing account)', count(*), sum(d.amount)
    from d where status in ('completed', 'collect')
      and (account_id is null or exists (select 1 from public.accounts a where a.org_id = d.org_id and a.id = d.account_id and a.name = 'Clearing (unassigned)'))$s$);
  if v_new = v_def then raise exception 'integrity_checks: account check not found'; end if;
  execute v_new;
end $$;
