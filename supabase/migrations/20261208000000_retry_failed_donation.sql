-- Retrying a failed donation (Moshe Henig, 2026-11-10: "any failed donation should have a retry button for admins").
-- The retry is a new charge through the usual Charge a card (or, for a recurring payment, the schedule's own
-- retry); the failed donation stays as the record of the decline, and a successful retry is linked to it
-- (replaces_donation_id) so it can't be retried twice and both point at each other.

-- What the Retry button needs to know about a failed donation (admins).
create or replace function public.failed_donation_retry(p_donation text)
returns table (status text, amount numeric, campaign_id text, donor_id text, card_id uuid, recurring_id uuid,
               method text, retried_as text, campaign_open boolean)
language sql stable security definer set search_path = '' as $$
  select d.status, coalesce(g.base_amount, d.amount), d.campaign_id, d.donor_id,
         -- The saved card or account, if it is still on file.
         (select k.id from public.donor_cards k where k.org_id = d.org_id and k.id = g.card_id and k.deleted_at is null),
         g.recurring_id, coalesce(g.method, case when d.payment_method ilike 'ach%' then 'ach' else 'card' end),
         (select r.id from public.donations r where r.org_id = d.org_id and r.replaces_donation_id = d.id
            and r.deleted_at is null and r.status in ('completed','collect') order by r.created_at desc limit 1),
         exists (select 1 from public.campaigns c where c.org_id = d.org_id and c.id = d.campaign_id and c.deleted_at is null and c.status <> 'closed')
  from public.donations d
  left join lateral (select * from public.gateway_transactions x where x.org_id = d.org_id and x.donation_id = d.id
                     order by x.created_at desc limit 1) g on true
  where d.org_id = public.current_org_id() and d.id = p_donation and d.deleted_at is null and public.is_admin()
$$;

-- After a retry goes through: the new donation replaces the failed one.
create or replace function public.link_donation_retry(p_failed text, p_new text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); f public.donations; n public.donations;
begin
  perform public.require_admin();
  select * into f from public.donations where org_id = v_org and id = p_failed and deleted_at is null;
  select * into n from public.donations where org_id = v_org and id = p_new and deleted_at is null;
  if f.id is null or n.id is null then raise exception 'Donation not found'; end if;
  if f.status <> 'failed' then raise exception 'Only a failed donation can be retried'; end if;
  if n.status not in ('completed','collect') then raise exception 'The retry didn''t go through'; end if;
  if n.id = f.id then raise exception 'A donation can''t replace itself'; end if;
  if exists (select 1 from public.donations r where r.org_id = v_org and r.replaces_donation_id = f.id and r.id <> n.id
             and r.deleted_at is null and r.status in ('completed','collect')) then
    raise exception 'This failed donation was already retried';
  end if;
  update public.donations set replaces_donation_id = f.id where org_id = v_org and id = n.id;
  update public.donations set notes = concat_ws(' · ', nullif(notes, ''), 'Retried as ' || n.id) where org_id = v_org and id = f.id;
  perform public.write_activity(v_org, 'donation_retried', 'donations', f.id, f.campaign_id, jsonb_build_object('retried_as', n.id, 'amount', n.amount));
end $$;

revoke execute on function public.failed_donation_retry(text) from public, anon;
revoke execute on function public.link_donation_retry(text, text) from public, anon;
