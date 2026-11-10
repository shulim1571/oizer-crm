-- RECENT shows the donor's full name instead of initials (Moshe Henig, approved by Shulim, 2026-11-10).
-- Each line is now: date, amount, campaign number and the donor's full name ("Anon" for an anonymous gift,
-- "No name" when none is on file). Who may ask, what they see, the 5-line limit and the rate limits are as in
-- 20261210000000_sms_recent_and_donary_setting.sql; only the name changes.

create or replace function public.phone_recent(p_org uuid, p_from text, p_campaign text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_from text := public.normalize_phone(p_from);
  v_admin boolean;
  v_manager text;
  v_ex boolean := coalesce((select s.exclude_donary from public.phone_lookup_settings s where s.org_id = p_org), false);
  v_tz text := coalesce((select o.timezone from public.organizations o where o.id = p_org), 'America/New_York');
  v_campaign text := nullif(trim(p_campaign), '');
  v_lines text;
begin
  if v_from is null then return null; end if;
  v_admin := exists (select 1 from public.org_members m
                     join public.notification_preferences p on p.org_id = m.org_id and p.user_id = m.user_id
                     where m.org_id = p_org and m.role in ('super_admin','admin') and m.status = 'active'
                       and public.normalize_phone(p.phone) = v_from);
  v_manager := case when v_admin then null else public.phone_fundraiser(p_org, p_from) end;

  -- Unknown phone: one polite reply a day, then nothing.
  if not v_admin and v_manager is null then
    if exists (select 1 from public.phone_lookups l where l.org_id = p_org and l.from_phone = v_from
               and l.outcome = 'recent_unknown' and l.at > now() - interval '24 hours') then return null; end if;
    insert into public.phone_lookups (org_id, channel, from_phone, outcome) values (p_org, 'sms', v_from, 'recent_unknown');
    return 'This phone isn''t registered for RECENT. Ask the office to add your number.';
  end if;

  -- 10 an hour per phone; past that, one notice and then silence for the hour.
  if (select count(*) from public.phone_lookups l where l.org_id = p_org and l.from_phone = v_from
        and l.outcome = 'recent' and l.at > now() - interval '1 hour') >= 10 then
    if exists (select 1 from public.phone_lookups l where l.org_id = p_org and l.from_phone = v_from
               and l.outcome = 'recent_limited' and l.at > now() - interval '1 hour') then return null; end if;
    insert into public.phone_lookups (org_id, channel, from_phone, outcome) values (p_org, 'sms', v_from, 'recent_limited');
    return 'Too many RECENT texts from this phone. Try again in an hour.';
  end if;

  insert into public.phone_lookups (org_id, channel, from_phone, campaign_id, outcome) values (p_org, 'sms', v_from, left(v_campaign, 20), 'recent');

  if v_campaign is not null and not exists (
       select 1 from public.campaigns c where c.org_id = p_org and c.id = v_campaign and c.deleted_at is null
         and (v_admin or c.manager_id = v_manager or v_manager = any(c.sub_manager_ids))) then
    return format('No campaign %s for this phone.', v_campaign);
  end if;

  select string_agg(line, E'\n' order by at desc) into v_lines from (
    select d.created_at as at,
           to_char(d.created_at at time zone v_tz, 'FMMM/FMDD') || ' ' || public.phone_money(d.amount) || ' #' || d.campaign_id || ' '
             || case when d.anonymous then 'Anon'
                     else coalesce(nullif(trim(concat_ws(' ', n.first_name, n.last_name)), ''), nullif(trim(d.name), ''), 'No name') end
             || case d.status when 'pending' then ' (awaiting approval)' when 'collect' then ' (to collect)' when 'post_dated' then ' (post-dated)' else '' end as line
    from public.donations d
    join public.campaigns c on c.org_id = d.org_id and c.id = d.campaign_id and c.deleted_at is null
    left join public.donors n on n.org_id = d.org_id and n.id = d.donor_id
    where d.org_id = p_org and d.deleted_at is null and d.status in ('completed','collect','post_dated','pending')
      and (v_campaign is null or d.campaign_id = v_campaign)
      and (v_admin or c.manager_id = v_manager or v_manager = any(c.sub_manager_ids))
      and not (v_ex and d.donary_id is not null)
    order by d.created_at desc
    limit 5) x;

  if v_lines is null then
    return case when v_campaign is null then 'No recent transactions.' else format('No recent transactions for #%s.', v_campaign) end;
  end if;
  return case when v_campaign is null then 'Recent:' else format('Recent for #%s:', v_campaign) end || E'\n' || v_lines;
end $$;

revoke execute on function public.phone_recent(uuid, text, text) from public, anon, authenticated;
grant execute on function public.phone_recent(uuid, text, text) to service_role;
