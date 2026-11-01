-- A returned check bounces as a whole, so every part of a split check goes with it. Each campaign
-- gets its own follow-up task for its part.
create or replace function public.return_check(p_id text, p_date date, p_reason text, p_notes text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  v_group text;
  v_found boolean := false;
  d public.donations;
begin
  perform public.require_admin();
  select split_group_id into v_group from public.donations where id = p_id and org_id = v_org;
  for d in
    update public.donations
    set status = 'returned', reversal_date = coalesce(p_date, current_date), reversal_reason = p_reason, reversal_notes = p_notes
    where org_id = v_org and (id = p_id or split_group_id = v_group) and deleted_at is null
      and status in ('completed','collect') and lower(coalesce(payment_method, '')) like '%check%'
    returning *
  loop
    v_found := true;
    if d.campaign_id is not null then
      insert into public.tasks (org_id, campaign_id, donor_id, title, description, status)
      values (v_org, d.campaign_id, d.donor_id,
              'Collect replacement for returned check: ' || coalesce(nullif(d.name, ''), nullif(d.donor_label, ''), 'donor') || ' $' || trim(to_char(d.amount, 'FM999,999,990.00')),
              'Bank reason: ' || coalesce(p_reason, 'not given'), 'Pending');
    end if;
  end loop;
  if not v_found then raise exception 'Only a completed check can be marked returned'; end if;
end $$;
