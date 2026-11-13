-- Each person chooses which kinds of notification they get (Moshe Henig, 2026-11-12). Every kind on My Notifications
-- (fundraisers' and admins') can now be Off as well as email, text or both; every kind starts on (email), and the
-- switch for all of them stays. Senders already pass the person's choice for that kind to notify_person, which now
-- sends nothing when it is off.
CREATE OR REPLACE FUNCTION public.save_notification_preferences(p_phone text, p_donation_alerts text, p_donation_min numeric, p_donation_campaigns text[], p_donation_digest text, p_task_alerts text, p_payout_alerts text, p_weekly_digests boolean, p_channels jsonb, p_message_alerts text DEFAULT 'immediate'::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_org uuid := public.current_org_id(); v_admin boolean := public.is_admin(); v_bad text;
begin
  if auth.uid() is null or not public.is_active_user() then raise exception 'Sign in first'; end if;
  if nullif(trim(p_phone), '') is not null and public.normalize_phone(p_phone) is null then raise exception '"%" isn''t a valid phone number', p_phone; end if;
  if p_donation_alerts = 'over' and coalesce(p_donation_min, 0) <= 0 then raise exception 'Enter the amount donations must reach'; end if;
  select k into v_bad from jsonb_each_text(coalesce(p_channels, '{}')) e(k, v) where v not in ('email','sms','both','off') limit 1;
  if v_bad is not null then raise exception 'Choose email, text, both or off for %', v_bad; end if;
  insert into public.notification_preferences (org_id, user_id, phone, donation_alerts, donation_min, donation_campaigns, donation_digest,
                                               task_alerts, payout_alerts, weekly_digests, channels, message_alerts, updated_at)
  values (v_org, auth.uid(), public.normalize_phone(p_phone),
          case when v_admin then coalesce(p_donation_alerts, 'off') else 'off' end,
          case when p_donation_alerts = 'over' then p_donation_min end,
          case when v_admin and cardinality(p_donation_campaigns) > 0 then p_donation_campaigns end,
          case when v_admin then coalesce(p_donation_digest, 'off') else 'off' end,
          coalesce(p_task_alerts, 'both'), coalesce(p_payout_alerts, 'immediate'), coalesce(p_weekly_digests, true),
          coalesce(p_channels, '{}'), coalesce(p_message_alerts, 'immediate'), now())
  on conflict (org_id, user_id) do update set phone = excluded.phone, donation_alerts = excluded.donation_alerts,
    donation_min = excluded.donation_min, donation_campaigns = excluded.donation_campaigns, donation_digest = excluded.donation_digest,
    task_alerts = excluded.task_alerts, payout_alerts = excluded.payout_alerts, weekly_digests = excluded.weekly_digests,
    channels = excluded.channels, message_alerts = excluded.message_alerts, updated_at = excluded.updated_at;
end $function$;

CREATE OR REPLACE FUNCTION public.notify_person(p_org uuid, p_email text, p_phone text, p_name text, p_channel text, p_kind text, p_subject text, p_lines text[], p_link text DEFAULT NULL::text, p_link_label text DEFAULT NULL::text, p_record text DEFAULT NULL::text, p_campaign text DEFAULT NULL::text, p_donor text DEFAULT NULL::text)
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
  if v_channel = 'off' then
    return;   -- this person turned this kind of notification off
  end if;
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
