-- Readiness #13 (2026-11-15): a processor time with no time zone was read as UTC, so "2026-11-12 01:30" (New York
-- time) landed at 8:30 PM on Nov 11. A time with no zone is now read in the organization's time zone (New York
-- unless set); a time with an offset or zone ("Z", "-05:00", "+0000", "UTC", "EST", "America/Chicago") is unchanged.
--
-- The check for "has a zone" also got two fixes:
--   * a date alone ("2026-11-12") ends in "-12", which was taken for an offset: it is a local date, not UTC;
--   * a zone written as a name ("... 01:30 UTC") was not seen, and a plain timestamp read silently drops it.

create or replace function public.local_time_text(p text, p_org uuid) returns text
language plpgsql stable set search_path = '' as $$
declare
  v text := trim(coalesce(p, ''));
begin
  if v = '' then return null; end if;
  -- An offset after a time of day, or a zone name at the end: already a full point in time.
  if v ~ '\d:\d\d(:\d\d(\.\d+)?)?\s*(Z|z|[+-]\d\d(:?\d\d)?)$'
     or v ~ '\d\s*(UTC|GMT|[A-Z]{3,4}|[A-Za-z_]+/[A-Za-z_]+)$' then
    return v;
  end if;
  return (v::timestamp at time zone public.org_zone(p_org))::text;
exception when others then
  return v;   -- unreadable here: left as it was for the caller to read (or report)
end $$;

-- Processor times: read in the organization's time zone when they carry none. With no organization given,
-- New York (the organization's zone; org_zone's default).
create or replace function public.make_time(p text, p_org uuid) returns timestamptz
language plpgsql stable set search_path = '' as $$
begin
  return coalesce(public.local_time_text(p, p_org)::timestamptz, now());
exception when others then
  return now();
end $$;

create or replace function public.make_time(p text) returns timestamptz
language sql stable set search_path = '' as $$
  select public.make_time(p, null::uuid)
$$;

revoke execute on function public.make_time(text, uuid) from public, anon;
revoke execute on function public.local_time_text(text, uuid) from public, anon;
