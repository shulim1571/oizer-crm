-- Address suggestions while typing a donor's (or payee's) address (Shulim, 2026-11-25), from Azure Maps Search Address
-- (api-version 1.0, typeahead, US only) through the address-suggest Edge Function. The Azure Maps key is an Edge
-- Function secret (AZURE_MAPS_KEY); the database never sees it. Each lookup is booked here first, as the signed-in
-- person, so usage stays within Azure Maps' free monthly allowance:
--   * staff only (admins and fundraisers of an active organization);
--   * 20 lookups a minute per person (the box waits about 300 ms after typing stops, and needs 3+ characters);
--   * 150 a day per organization;
--   * 4,500 a calendar month across all organizations (Azure Maps' free tier is 5,000 a month).
-- Only counts are kept: who asked, when, for which organization; never the text typed. Rows older than 40 days are
-- removed as new ones come in.

create table if not exists public.address_lookups (
  id         bigint generated always as identity primary key,
  org_id     uuid not null references public.organizations(id),
  user_id    uuid not null,
  created_at timestamptz not null default now()
);
create index if not exists address_lookups_org_time on public.address_lookups (org_id, created_at);
create index if not exists address_lookups_user_time on public.address_lookups (user_id, created_at);
create index if not exists address_lookups_time on public.address_lookups (created_at);
-- Read and written only by the function below.
alter table public.address_lookups enable row level security;
revoke all on public.address_lookups from public, anon, authenticated;

create or replace function public.address_suggest_begin() returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_uid uuid := auth.uid();
begin
  if v_org is null or v_uid is null or not public.is_active_user() then raise exception 'Sign in to look up addresses'; end if;
  -- One person at a time, so two quick lookups can't both slip under a limit.
  perform pg_advisory_xact_lock(hashtext('address_suggest'), hashtext(v_uid::text));
  if (select count(*) from public.address_lookups l where l.user_id = v_uid and l.created_at > now() - interval '1 minute') >= 20 then
    raise exception 'Address suggestions are paused for a moment; keep typing or try again in a minute';
  end if;
  if (select count(*) from public.address_lookups l where l.org_id = v_org and l.created_at > now() - interval '1 day') >= 150 then
    raise exception 'Address suggestions have reached today''s limit; type the address in full';
  end if;
  if (select count(*) from public.address_lookups l where l.created_at >= date_trunc('month', now())) >= 4500 then
    raise exception 'Address suggestions have reached this month''s limit; type the address in full';
  end if;
  insert into public.address_lookups (org_id, user_id) values (v_org, v_uid);
  delete from public.address_lookups l where l.created_at < now() - interval '40 days';
  return v_org;
end $$;
revoke execute on function public.address_suggest_begin() from public, anon;
grant execute on function public.address_suggest_begin() to authenticated;
