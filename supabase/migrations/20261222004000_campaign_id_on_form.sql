-- Campaign IDs on the New Campaign form (Moshe Henig, 2026-11-15): the form is prefilled with the next number
-- (next_campaign_id, the same rule the database uses when none is given) and the admin may change it. An ID typed in
-- is checked here: allowed characters, and unique in the organization regardless of capitals, including deleted
-- campaigns. IDs stay permanent once created.
CREATE OR REPLACE FUNCTION public.campaign_before_write()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if tg_op = 'INSERT' then
    -- An ID typed on the New Campaign form (Moshe Henig, 2026-11-15): letters, numbers and dashes (it goes in the
    -- payment page's address), and not one any campaign has used, in any capitalization. Empty: the next number.
    new.id := nullif(trim(new.id), '');
    if new.id is not null then
      if new.id !~ '^[A-Za-z0-9][A-Za-z0-9-]{0,39}$' then
        raise exception 'A campaign ID is up to 40 letters, numbers and dashes (no spaces), starting with a letter or number';
      end if;
      if exists (select 1 from public.campaigns c where c.org_id = new.org_id and lower(c.id) = lower(new.id)) then
        raise exception 'Campaign ID % is already taken. Choose another, or leave it empty for the next number', new.id;
      end if;
    end if;
    if new.id is null then
      perform pg_advisory_xact_lock(hashtext('campaign_id:' || new.org_id::text));
      select (greatest(coalesce(max(c.id::bigint), 0), 999) + 1)::text into new.id
      from public.campaigns c where c.org_id = new.org_id and c.id ~ '^\d+$';
    end if;
    new.external_name := coalesce(nullif(trim(new.external_name), ''), new.internal_name);
  else
    if new.id <> old.id and auth.uid() is not null then
      raise exception 'Campaign IDs are permanent';
    end if;
    if old.status = 'closed' and new.status <> 'closed' and auth.uid() is not null
       and not public.has_super_permission('reopen_campaigns') then
      raise exception 'Only the Super Admin can reopen a closed campaign';
    end if;
    if nullif(trim(new.external_name), '') is null
       or (new.internal_name is distinct from old.internal_name and old.external_name = old.internal_name
           and new.external_name is not distinct from old.external_name) then
      new.external_name := new.internal_name;
    end if;
  end if;

  if tg_op = 'INSERT' or new.status is distinct from old.status then
    new.archived_at := case when new.status = 'archived' then coalesce(new.archived_at, now()) end;
    new.closed_at := case when new.status = 'closed' then coalesce(new.closed_at, now()) end;
  end if;
  return new;
end $function$;

create or replace function public.next_campaign_id() returns text
language sql stable security definer set search_path = '' as $$
  select case when public.is_admin() then (greatest(coalesce(max(c.id::bigint), 0), 999) + 1)::text end
  from public.campaigns c where c.org_id = public.current_org_id() and c.id ~ '^\d+$'
$$;
revoke execute on function public.next_campaign_id() from public, anon;
grant execute on function public.next_campaign_id() to authenticated;
