-- Log sign-ins from the auth record, so confirmation links, password resets and the login form all
-- count. There's no signed-in request at this point, so the user is taken from the row.
create or replace function public.log_sign_in() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.activity_log (user_id, user_email, user_role, action)
  values (new.id, new.email, (select role from public.profiles where user_id = new.id), 'login');
  return null;
exception when others then
  return null;  -- this runs inside the sign-in itself; a log failure must never lock anyone out
end $$;
revoke execute on function public.log_sign_in() from public, anon, authenticated;

create trigger log_sign_in after update of last_sign_in_at on auth.users
  for each row when (new.last_sign_in_at is distinct from old.last_sign_in_at)
  execute function public.log_sign_in();

-- The app no longer reports sign-ins itself; accepting them would allow false entries.
create or replace function public.log_activity(p_action text, p_detail jsonb default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;
  if p_action <> all (array['logout','export']) then
    raise exception 'Unknown activity %', p_action;
  end if;
  if pg_column_size(p_detail) > 4096 then
    raise exception 'Activity detail too large';
  end if;
  perform public.write_activity(p_action, null, null, null, p_detail);
end $$;
