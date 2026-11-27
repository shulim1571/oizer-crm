-- Supabase's password verification hook needs the Team plan, so the sign-in Edge Function now does
-- this job: it asks whether an account is locked, tries the password, and reports the result.

drop function public.hook_password_verification_attempt(jsonb);

create or replace function public.login_locked(p_email text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.login_attempts a
                 join auth.users u on u.id = a.user_id
                 where lower(u.email) = lower(p_email) and a.locked_until > now())
$$;

-- Returns true when this failure locked the account. Unknown emails are ignored.
create or replace function public.record_login_attempt(p_email text, p_valid boolean) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid;
  v_email text;
  v_count int;
begin
  select id, email into v_user, v_email from auth.users where lower(email) = lower(p_email);
  if v_user is null then return false; end if;

  if p_valid then
    delete from public.login_attempts where user_id = v_user;
    return false;
  end if;

  -- An expired lock starts the count again.
  insert into public.login_attempts (user_id, failed_count) values (v_user, 1)
  on conflict (user_id) do update
    set failed_count = case when public.login_attempts.locked_until is null
                            then public.login_attempts.failed_count + 1 else 1 end,
        locked_until = null, updated_at = now()
  returning failed_count into v_count;

  perform public.log_user_event(v_user, v_email, 'login_failed');

  if v_count >= 5 then
    update public.login_attempts set locked_until = now() + interval '1 hour', updated_at = now() where user_id = v_user;
    perform public.log_user_event(v_user, v_email, 'account_locked');
    return true;
  end if;
  return false;
end $$;

revoke execute on function public.login_locked(text) from public, anon, authenticated;
revoke execute on function public.record_login_attempt(text, boolean) from public, anon, authenticated;
grant execute on function public.login_locked(text) to service_role;
grant execute on function public.record_login_attempt(text, boolean) to service_role;
