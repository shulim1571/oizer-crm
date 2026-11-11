-- The payment page always shows the campaign's current name (Moshe Henig, 2026-11-11). The page shows the external
-- name, which a new campaign got as a copy of its internal name; renaming the campaign later changed only the
-- internal name, so the page kept the old copy. Now an external name that was just a copy follows the internal name,
-- and an emptied external name falls back to the internal name (the form says "Uses the internal name if left
-- empty"). An external name set on purpose (different from the internal one) stays as set.
create or replace function public.campaign_before_write() returns trigger
language plpgsql security definer set search_path = '' as $function$
begin
  if tg_op = 'INSERT' then
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
