-- The app is renamed from Donor Base to FundBase (Shulim, 2026-11-22). The guest invitation email names the app; only
-- its wording changes (the function is otherwise as in 20261222007800_guest_invites.sql).

create or replace function public.guest_invite_message(p_org uuid, p_campaign text, p_email text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_org_name text; v_campaign text; v_host text; v_link text; v_body text;
begin
  select coalesce(nullif(o.name, ''), 'FundBase') into v_org_name from public.organizations o where o.id = p_org;
  select coalesce(nullif(c.external_name, ''), nullif(c.internal_name, ''), c.id) into v_campaign
    from public.campaigns c where c.org_id = p_org and c.id = p_campaign;
  select d.hostname into v_host from public.org_domains d where d.org_id = p_org order by d.hostname limit 1;
  v_link := case when v_host is not null then 'https://' || v_host || '/' else null end;
  v_body := v_org_name || ' has invited you to follow the campaign "' || coalesce(v_campaign, p_campaign) || '" on FundBase.' || E'\n\n'
         || 'You''ll see its donations as they come in: donor names (anonymous gifts stay anonymous), amounts, how they were given and when.'
         || E'\n\n' || 'To start, sign up' || coalesce(' at ' || v_link, '') || ' with this email address (' || p_email || ').'
         || ' Nothing else is needed; you''ll see the campaign as soon as you''re signed in.';
  return public.queue_message(p_org, 'email', p_email, null, 'You''re invited to follow ' || coalesce(v_campaign, p_campaign), v_body, null,
                              'guest_invite', p_campaign, null, p_campaign);
end $$;
revoke execute on function public.guest_invite_message(uuid, text, text) from public, anon, authenticated;
