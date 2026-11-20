-- An admin booking a machine picks the fundraiser it's for (Moshe Henig, 2026-11-10). The booking is made under
-- that fundraiser's name as a normal request: pending, or waitlisted when every machine is taken that day. Machine
-- assignment and confirmation stay as they are. The fundraiser must be active and on the campaign (its primary or a
-- secondary). Without a fundraiser, an admin's booking goes under the campaign's primary as before; fundraisers
-- can't choose anyone but themselves.

drop function if exists public.request_machine(date, text, text);

create or replace function public.request_machine(p_date date, p_campaign text, p_notes text default null, p_manager text default null) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  c public.campaigns;
  v_manager text;
  v_status text := 'pending';
  v_id text;
begin
  perform public.require_booking_user();
  if p_date is null or p_date < public.org_today() then raise exception 'Choose today or a later date'; end if;
  select * into c from public.campaigns where org_id = v_org and id = p_campaign and deleted_at is null and status <> 'closed';
  if c.id is null then raise exception 'Choose an open campaign'; end if;
  if public.is_admin() then
    if nullif(trim(p_manager), '') is not null then
      if not exists (select 1 from public.managers m where m.org_id = v_org and m.id = p_manager and m.deleted_at is null
                     and coalesce(m.status, 'active') = 'active') then
        raise exception 'Choose an active fundraiser';
      end if;
      if not (c.manager_id = p_manager or p_manager = any(c.sub_manager_ids)) then
        raise exception 'That fundraiser isn''t on campaign %', c.id;
      end if;
      v_manager := p_manager;
    else
      v_manager := c.manager_id;
    end if;
  else
    if nullif(trim(p_manager), '') is not null and not (p_manager = any(public.my_manager_ids())) then
      raise exception 'You can only book a machine for yourself';
    end if;
    if not (p_campaign = any(public.my_campaign_ids())) then raise exception 'That campaign isn''t yours'; end if;
    v_manager := case when c.manager_id = any(public.my_manager_ids()) then c.manager_id else (public.my_manager_ids())[1] end;
  end if;
  perform public.lock_machine_day(p_date);
  if (select count(*) from public.machine_bookings b where b.org_id = v_org and b.booking_date = p_date and b.status in ('pending','confirmed'))
     >= (select count(*) from public.machines m where m.org_id = v_org and m.active) then
    v_status := 'waitlisted';
  end if;
  insert into public.machine_bookings (org_id, booking_date, campaign_id, manager_id, notes, status)
  values (v_org, p_date, p_campaign, v_manager, nullif(trim(p_notes), ''), v_status)
  returning id into v_id;
  return v_id;
end $$;

revoke execute on function public.request_machine(date, text, text, text) from public, anon;
grant execute on function public.request_machine(date, text, text, text) to authenticated;
