-- Fundraisers see transfers in and out of their campaigns, read-only (Moshe Henig, 2026-11-15). The transfers table
-- stays admin-only (its policies are unchanged); this function is the fundraiser's window onto it:
--   * only for a campaign they work on (primary or secondary), and only that campaign's transfers;
--   * date, amount, direction (in or out) and memo; the other campaign is named only when they work on it too,
--     otherwise it shows as "another campaign"; admins' internal notes and who entered it are left out.
-- Admins get the same rows with everything named; they keep creating and editing transfers as before.
create or replace function public.campaign_transfers(p_campaign text)
returns table (id text, created_at timestamptz, amount numeric, direction text, other_campaign_id text, other_campaign_name text, description text)
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_admin boolean := public.is_admin(); v_mine text[] := coalesce(public.my_campaign_ids(), '{}');
begin
  if v_org is null or not (v_admin or p_campaign = any(v_mine)) then return; end if;
  return query
  select t.id, t.created_at, t.amount,
         case when t.to_campaign_id = p_campaign then 'in' else 'out' end,
         case when v_admin or o.id = any(v_mine) then o.id end,
         case when v_admin or o.id = any(v_mine) then coalesce(o.internal_name, o.campaign_name, o.external_name) else 'another campaign' end,
         t.description
  from public.transfers t
  left join public.campaigns o on o.org_id = t.org_id
    and o.id = case when t.to_campaign_id = p_campaign then t.from_campaign_id else t.to_campaign_id end
  where t.org_id = v_org and t.deleted_at is null and (t.from_campaign_id = p_campaign or t.to_campaign_id = p_campaign)
  order by t.created_at desc;
end $$;
revoke execute on function public.campaign_transfers(text) from public, anon;
grant execute on function public.campaign_transfers(text) to authenticated;
