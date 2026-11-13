-- Fix-up for 20261222002600_notifications_switch: notice_admins builds a default preferences row for admins who never
-- saved any, field by field; it needs the new notifications_on field (on), or the cast fails and admin notices stop.
-- Otherwise unchanged from the live definition. An admin who turned notifications off is skipped by notify_person.
CREATE OR REPLACE FUNCTION public.notice_admins(p_org uuid)
 RETURNS TABLE(user_id uuid, email text, name text, phone text, prefs notification_preferences)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select m.user_id, u.email, coalesce(nullif(trim(u.raw_user_meta_data ->> 'full_name'), ''), u.email), p.phone,
         coalesce(p, row(p_org, m.user_id, null, 'off', null, null, 'off', 'both', 'immediate', true, '{}'::jsonb, now(), 'immediate', true)::public.notification_preferences)
  from public.org_members m
  join auth.users u on u.id = m.user_id
  left join public.notification_preferences p on p.org_id = m.org_id and p.user_id = m.user_id
  where m.org_id = p_org and m.role in ('super_admin','admin') and m.status = 'active'
$function$

;
