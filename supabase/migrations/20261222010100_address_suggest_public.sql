-- Address suggestions on the public payment page (Moshe, 2026-11-25): donors aren't signed in, so the address-suggest
-- Edge Function books their lookups here, with the server key, instead of as a person. Their own limits, so a busy (or
-- abused) payment page can't use up the staff's suggestions:
--   * only for a campaign whose payment page is open (give_page_core answers);
--   * 20 lookups in 10 minutes and 60 a day from one connection (a keyed hash of its address, never the address);
--   * 100 a day per organization from payment pages; staff keep their own 150 (address_suggest_begin, now staff only);
--   * the 4,500 a month in all still covers both (Azure Maps' free tier is 5,000).
-- As before, only counts are kept (who/when/where from), never the text typed; rows go after 40 days.

alter table public.address_lookups alter column user_id drop not null;
alter table public.address_lookups add column if not exists campaign_id text;
alter table public.address_lookups add column if not exists ip_hash text;
create index if not exists address_lookups_ip_time on public.address_lookups (ip_hash, created_at) where ip_hash is not null;

-- Staff lookups: the organization's daily 150 now counts staff lookups only (payment pages have their own).
create or replace function public.address_suggest_begin() returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_uid uuid := auth.uid();
begin
  if v_org is null or v_uid is null or not public.is_active_user() then raise exception 'Sign in to look up addresses'; end if;
  perform pg_advisory_xact_lock(hashtext('address_suggest'), hashtext(v_uid::text));
  if (select count(*) from public.address_lookups l where l.user_id = v_uid and l.created_at > now() - interval '1 minute') >= 20 then
    raise exception 'Address suggestions are paused for a moment; keep typing or try again in a minute';
  end if;
  if (select count(*) from public.address_lookups l where l.org_id = v_org and l.user_id is not null and l.created_at > now() - interval '1 day') >= 150 then
    raise exception 'Address suggestions have reached today''s limit; type the address in full';
  end if;
  if (select count(*) from public.address_lookups l where l.created_at >= date_trunc('month', now())) >= 4500 then
    raise exception 'Address suggestions have reached this month''s limit; type the address in full';
  end if;
  insert into public.address_lookups (org_id, user_id) values (v_org, v_uid);
  delete from public.address_lookups l where l.created_at < now() - interval '40 days';
  return v_org;
end $$;

-- A payment page lookup, booked by the Edge Function (server key only). Returns null when booked, otherwise the
-- message to show the donor.
create or replace function public.address_suggest_public_begin(p_org uuid, p_campaign text, p_ip_hash text) returns text
language plpgsql security definer set search_path = '' as $$
declare v_who text := coalesce(nullif(p_ip_hash, ''), 'unknown');
begin
  if p_org is null or p_campaign is null or public.give_page_core(p_org, p_campaign) is null then
    return 'Address suggestions aren''t available on this page';
  end if;
  perform pg_advisory_xact_lock(hashtext('address_suggest_public'), hashtext(v_who));
  if (select count(*) from public.address_lookups l where l.ip_hash = v_who and l.created_at > now() - interval '10 minutes') >= 20
     or (select count(*) from public.address_lookups l where l.ip_hash = v_who and l.created_at > now() - interval '1 day') >= 60 then
    return 'Address suggestions are paused for a moment; type the address in full';
  end if;
  if (select count(*) from public.address_lookups l where l.org_id = p_org and l.user_id is null and l.created_at > now() - interval '1 day') >= 100
     or (select count(*) from public.address_lookups l where l.created_at >= date_trunc('month', now())) >= 4500 then
    return 'Address suggestions aren''t available right now; type the address in full';
  end if;
  insert into public.address_lookups (org_id, campaign_id, ip_hash) values (p_org, p_campaign, v_who);
  delete from public.address_lookups l where l.created_at < now() - interval '40 days';
  return null;
end $$;
revoke execute on function public.address_suggest_public_begin(uuid, text, text) from public, anon, authenticated;
