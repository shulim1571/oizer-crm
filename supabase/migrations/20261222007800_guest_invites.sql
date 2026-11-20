-- Readiness #63 (2026-11-15): a campaign guest now gets an invitation email when added, saying which campaign they
-- can follow and how to sign in (with the email they were added under). It goes through the message queue like any
-- other message, so while sending is in test mode it's held. "Send the invitation again" re-sends it.

create or replace function public.guest_invite_message(p_org uuid, p_campaign text, p_email text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_org_name text; v_campaign text; v_host text; v_link text; v_body text;
begin
  select coalesce(nullif(o.name, ''), 'Donor Base') into v_org_name from public.organizations o where o.id = p_org;
  select coalesce(nullif(c.external_name, ''), nullif(c.internal_name, ''), c.id) into v_campaign
    from public.campaigns c where c.org_id = p_org and c.id = p_campaign;
  select d.hostname into v_host from public.org_domains d where d.org_id = p_org order by d.hostname limit 1;
  v_link := case when v_host is not null then 'https://' || v_host || '/' else null end;
  v_body := v_org_name || ' has invited you to follow the campaign "' || coalesce(v_campaign, p_campaign) || '" on Donor Base.' || E'\n\n'
         || 'You''ll see its donations as they come in: donor names (anonymous gifts stay anonymous), amounts, how they were given and when.'
         || E'\n\n' || 'To start, sign up' || coalesce(' at ' || v_link, '') || ' with this email address (' || p_email || ').'
         || ' Nothing else is needed; you''ll see the campaign as soon as you''re signed in.';
  return public.queue_message(p_org, 'email', p_email, null, 'You''re invited to follow ' || coalesce(v_campaign, p_campaign), v_body, null,
                              'guest_invite', p_campaign, null, p_campaign);
end $$;
revoke execute on function public.guest_invite_message(uuid, text, text) from public, anon, authenticated;

create or replace function public.invite_new_guest() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  begin
    perform public.guest_invite_message(new.org_id, new.campaign_id, new.email);
  exception when others then
    null;   -- an invitation that can't be queued doesn't stop adding the guest (the admin can send it again)
  end;
  return null;
end $$;
revoke execute on function public.invite_new_guest() from public, anon, authenticated;
drop trigger if exists invite_new_guest on public.campaign_guests;
create trigger invite_new_guest after insert on public.campaign_guests for each row execute function public.invite_new_guest();

-- An admin re-sends the invitation.
create or replace function public.resend_guest_invite(p_campaign text, p_email text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  perform public.require_admin();
  if not exists (select 1 from public.campaign_guests g where g.org_id = v_org and g.campaign_id = p_campaign and lower(g.email) = lower(p_email)) then
    raise exception 'That guest isn''t on this campaign';
  end if;
  return public.guest_invite_message(v_org, p_campaign, lower(p_email));
end $$;
revoke execute on function public.resend_guest_invite(text, text) from public, anon;
grant execute on function public.resend_guest_invite(text, text) to authenticated;
