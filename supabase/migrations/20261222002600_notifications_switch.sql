-- Each person can turn their own notifications off (Moshe Henig, 2026-11-12: "a fundraiser should also have the
-- option of turning off his notifications"). One switch on My Notifications; while it's off, no notification email or
-- text reaches them. Their detailed choices are kept for when they turn it back on. Messages someone deliberately
-- sends them (a check, a receipt, an outreach message with its own unsubscribe) are not notifications and still go.
alter table public.notification_preferences add column if not exists notifications_on boolean not null default true;

create or replace function public.set_my_notifications(p_on boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is null or v_org is null or not public.is_active_user() then raise exception 'Sign in first'; end if;
  insert into public.notification_preferences (org_id, user_id, notifications_on, updated_at)
  values (v_org, auth.uid(), coalesce(p_on, true), now())
  on conflict (org_id, user_id) do update set notifications_on = coalesce(p_on, true), updated_at = now();
end $$;
revoke execute on function public.set_my_notifications(boolean) from public, anon;
grant execute on function public.set_my_notifications(boolean) to authenticated;

-- The one place notifications are sent from: it now skips anyone who turned theirs off, matched by their login
-- email, the email or phone on their fundraiser record, or the phone they gave for notifications.
create or replace function public.notify_person(p_org uuid, p_email text, p_phone text, p_name text, p_channel text, p_kind text,
  p_subject text, p_lines text[], p_link text DEFAULT NULL::text, p_link_label text DEFAULT NULL::text, p_record text DEFAULT NULL::text,
  p_campaign text DEFAULT NULL::text, p_donor text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_channel text := coalesce(p_channel, 'email');
  v_email boolean := v_channel in ('email','both') or (v_channel = 'sms' and public.normalize_phone(p_phone) is null);
  v_sms boolean := v_channel in ('sms','both') and public.normalize_phone(p_phone) is not null;
  v_mail text := lower(nullif(trim(p_email), ''));
  v_phone text := public.normalize_phone(p_phone);
begin
  if exists (
    select 1 from public.notification_preferences np
    join auth.users u on u.id = np.user_id
    left join public.managers m on m.org_id = np.org_id and lower(m.email) = lower(u.email)
    where np.org_id = p_org and not np.notifications_on
      and ((v_mail is not null and v_mail in (lower(u.email), lower(m.email)))
        or (v_phone is not null and v_phone in (public.normalize_phone(np.phone), public.normalize_phone(m.phone))))
  ) then
    return;   -- they turned their notifications off
  end if;
  if v_email and public.normalize_address('email', p_email) is not null then
    begin
      perform public.queue_message(p_org, 'email', p_email, p_name, p_subject, public.notice_text(p_subject, p_lines, p_link),
        public.notice_html(p_org, p_subject, p_lines, p_link, p_link_label), p_kind, p_record, p_donor, p_campaign);
    exception when others then null;
    end;
  end if;
  if v_sms then
    begin
      perform public.queue_message(p_org, 'sms', p_phone, p_name, null,
        left(public.notice_text(p_subject, p_lines, p_link), 600), null, p_kind, p_record, p_donor, p_campaign);
    exception when others then null;
    end;
  end if;
end $function$;
