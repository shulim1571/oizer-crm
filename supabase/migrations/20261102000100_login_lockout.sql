-- Five wrong passwords in a row lock an account for an hour. Supabase Auth calls this hook on every
-- password check once it's switched on under Authentication > Hooks in the dashboard. Until then
-- nothing is counted and nobody is locked out.

create table public.login_attempts (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  failed_count int not null default 0,
  locked_until timestamptz,
  updated_at   timestamptz not null default now()
);
alter table public.login_attempts enable row level security;
revoke all on public.login_attempts from anon, authenticated;

create or replace function public.hook_password_verification_attempt(event jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := (event ->> 'user_id')::uuid;
  v_valid boolean := (event ->> 'valid')::boolean;
  v_email text;
  v_locked timestamptz;
  v_count int;
  v_reject constant jsonb := jsonb_build_object(
    'decision', 'reject',
    'message', 'Too many failed attempts. Please try again in 1 hour, or reset your password.',
    'should_logout_user', false);
begin
  select locked_until into v_locked from public.login_attempts where user_id = v_user for update;
  if v_locked > now() then
    return v_reject;
  end if;

  if v_valid then
    delete from public.login_attempts where user_id = v_user;
    return jsonb_build_object('decision', 'continue');
  end if;

  -- An expired lock starts the count again.
  insert into public.login_attempts (user_id, failed_count) values (v_user, 1)
  on conflict (user_id) do update
    set failed_count = case when public.login_attempts.locked_until is null
                            then public.login_attempts.failed_count + 1 else 1 end,
        locked_until = null, updated_at = now()
  returning failed_count into v_count;

  select email into v_email from auth.users where id = v_user;
  perform public.log_user_event(v_user, v_email, 'login_failed');

  if v_count >= 5 then
    update public.login_attempts set locked_until = now() + interval '1 hour', updated_at = now() where user_id = v_user;
    perform public.log_user_event(v_user, v_email, 'account_locked');
    return v_reject;
  end if;
  return jsonb_build_object('decision', 'continue');
end $$;

-- Resetting a password restores access straight away.
create or replace function public.clear_lockout_on_password_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.login_attempts where user_id = new.id;
  return null;
exception when others then
  return null;
end $$;
create trigger clear_lockout after update of encrypted_password on auth.users
  for each row when (new.encrypted_password is distinct from old.encrypted_password)
  execute function public.clear_lockout_on_password_change();

-- Locked logins in the admin's own organization.
create or replace function public.locked_accounts() returns table (user_id uuid, locked_until timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then
    raise exception 'Only admins can see locked accounts';
  end if;
  return query
    select a.user_id, a.locked_until
    from public.login_attempts a
    join public.org_members m on m.user_id = a.user_id and m.org_id = public.current_org_id()
    where a.locked_until > now();
end $$;

create or replace function public.unlock_account(p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() or not exists (
    select 1 from public.org_members m where m.user_id = p_user and m.org_id = public.current_org_id()) then
    raise exception 'Only an admin of their organization can unlock this account';
  end if;
  delete from public.login_attempts where user_id = p_user;
  perform public.write_activity(public.current_org_id(), 'unlock_account', 'profiles', p_user::text, null, null);
end $$;

grant usage on schema public to supabase_auth_admin;
revoke execute on function public.hook_password_verification_attempt(jsonb) from public, anon, authenticated;
grant execute on function public.hook_password_verification_attempt(jsonb) to supabase_auth_admin;
revoke execute on function public.clear_lockout_on_password_change() from public, anon, authenticated;
revoke execute on function public.locked_accounts()    from public, anon;
revoke execute on function public.unlock_account(uuid) from public, anon;
grant execute on function public.locked_accounts()     to authenticated;
grant execute on function public.unlock_account(uuid)  to authenticated;
