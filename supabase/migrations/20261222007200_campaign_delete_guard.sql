-- Readiness #53 (2026-11-15): a campaign with money left could be deleted, and the money vanished from every total.
-- (Deleting one with sub-campaigns or teams, or a team with gifts, was already refused: campaign_tree_guard.) Now a
-- campaign can be deleted only once its balance is zero; otherwise pay it out or transfer it first, or archive it.
-- This applies to people using the app; the system's own maintenance isn't stopped.
create or replace function public.campaign_balance_delete_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_balance numeric;
begin
  if new.deleted_at is not null and old.deleted_at is null and auth.uid() is not null then
    select s.balance into v_balance from public.campaign_summary s where s.org_id = old.org_id and s.id = old.id;
    if coalesce(v_balance, 0) <> 0 then
      raise exception 'Campaign % still has a balance of %. Pay it out or transfer it first, or archive the campaign instead',
        old.id, to_char(v_balance, 'FM$999,999,990.00');
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.campaign_balance_delete_guard() from public, anon, authenticated;
drop trigger if exists campaign_delete_guard on public.campaigns;
drop trigger if exists campaign_zz_balance_guard on public.campaigns;
-- Named to run after campaign_tree_guard, so its messages come first.
create trigger campaign_zz_balance_guard before update of deleted_at on public.campaigns
  for each row execute function public.campaign_balance_delete_guard();
