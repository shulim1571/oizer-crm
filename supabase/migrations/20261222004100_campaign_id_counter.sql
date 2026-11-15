-- Campaign ID auto-numbering with its own counter (Moshe Henig, 2026-11-15). Each organization sets the number to start
-- at (setting campaign_id_start, default 1000). New campaigns created without an ID take the counter's number (the next
-- free one at or after it) and the counter moves on by one; IDs typed by hand are ignored by it. Changing the start
-- number restarts the counter there (taken numbers are still skipped). Before this, the next ID was the highest number
-- in use plus one, so one typed by hand (3297) moved everything after it; each counter now starts just after the
-- organization's first unbroken run of numbers from 1000 (Oizer: 1001-1013, so 1014).
create table public.campaign_id_counters (
  org_id       uuid primary key references public.organizations(id),
  start_number bigint not null,
  next_number  bigint not null
);
alter table public.campaign_id_counters enable row level security;
revoke all on public.campaign_id_counters from public, anon, authenticated;

-- The organization's start setting (a whole number of at least 1), else 1000.
create or replace function public.campaign_id_start(p_org uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce((select case when (s.value #>> '{}') ~ '^\d{1,12}$' and (s.value #>> '{}')::bigint >= 1 then (s.value #>> '{}')::bigint end
                   from public.settings s where s.org_id = p_org and s.key = 'campaign_id_start'), 1000)
$$;

-- The counter as it stands: restarted at the start number if that setting changed; created on first use.
create or replace function public.campaign_id_counter(p_org uuid) returns public.campaign_id_counters
language plpgsql security definer set search_path = '' as $$
declare v_start bigint := public.campaign_id_start(p_org); c public.campaign_id_counters;
begin
  select * into c from public.campaign_id_counters where org_id = p_org for update;
  if c.org_id is null then
    insert into public.campaign_id_counters (org_id, start_number, next_number) values (p_org, v_start, v_start) returning * into c;
  elsif c.start_number <> v_start then
    update public.campaign_id_counters set start_number = v_start, next_number = v_start where org_id = p_org returning * into c;
  end if;
  return c;
end $$;

-- The number the counter would give now: its own, or the next free one after it.
create or replace function public.campaign_id_peek(p_org uuid) returns bigint
language plpgsql stable security definer set search_path = '' as $$
declare v_start bigint := public.campaign_id_start(p_org); n bigint;
begin
  select case when start_number = v_start then next_number else v_start end into n from public.campaign_id_counters where org_id = p_org;
  n := coalesce(n, v_start);
  while exists (select 1 from public.campaigns c where c.org_id = p_org and c.id = n::text) loop n := n + 1; end loop;
  return n;
end $$;

-- Takes that number and moves the counter past it.
create or replace function public.campaign_id_take(p_org uuid) returns bigint
language plpgsql security definer set search_path = '' as $$
declare c public.campaign_id_counters := public.campaign_id_counter(p_org); n bigint := c.next_number;
begin
  while exists (select 1 from public.campaigns x where x.org_id = p_org and x.id = n::text) loop n := n + 1; end loop;
  update public.campaign_id_counters set next_number = n + 1 where org_id = p_org;
  return n;
end $$;

CREATE OR REPLACE FUNCTION public.campaign_before_write()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if tg_op = 'INSERT' then
    -- An ID typed on the New Campaign form (Moshe Henig, 2026-11-15): letters, numbers and dashes (it goes in the
    -- payment page's address), and not one any campaign has used, in any capitalization. Empty: the next number.
    new.id := nullif(trim(new.id), '');
    if new.id is not null then
      if new.id !~ '^[A-Za-z0-9][A-Za-z0-9-]{0,39}$' then
        raise exception 'A campaign ID is up to 40 letters, numbers and dashes (no spaces), starting with a letter or number';
      end if;
      if exists (select 1 from public.campaigns c where c.org_id = new.org_id and lower(c.id) = lower(new.id)) then
        raise exception 'Campaign ID % is already taken. Choose another, or leave it empty for the next number', new.id;
      end if;
    end if;
    -- Auto-numbering from the organization's own counter (Moshe Henig, 2026-11-15): the next free number at or after
    -- it, after which it moves on by one. An ID typed by hand doesn't touch the counter, unless it is the counter's
    -- own number (the prefilled suggestion saved as is), which then moves past it.
    perform pg_advisory_xact_lock(hashtext('campaign_id:' || new.org_id::text));
    if new.id is null then
      new.id := public.campaign_id_take(new.org_id)::text;
    elsif new.id ~ '^\d+$' and new.id::numeric = public.campaign_id_peek(new.org_id) then
      perform public.campaign_id_take(new.org_id);
    end if;
    new.external_name := coalesce(nullif(trim(new.external_name), ''), new.internal_name);
  else
    if new.id <> old.id and auth.uid() is not null then
      raise exception 'Campaign IDs are permanent';
    end if;
    if old.status = 'closed' and new.status <> 'closed' and auth.uid() is not null
       and not public.has_super_permission('reopen_campaigns') then
      raise exception 'Only the Super Admin can reopen a closed campaign';
    end if;
    if nullif(trim(new.external_name), '') is null
       or (new.internal_name is distinct from old.internal_name and old.external_name = old.internal_name
           and new.external_name is not distinct from old.external_name) then
      new.external_name := new.internal_name;
    end if;
  end if;

  if tg_op = 'INSERT' or new.status is distinct from old.status then
    new.archived_at := case when new.status = 'archived' then coalesce(new.archived_at, now()) end;
    new.closed_at := case when new.status = 'closed' then coalesce(new.closed_at, now()) end;
  end if;
  return new;
end $function$;

-- What the New Campaign form suggests (admins).
create or replace function public.next_campaign_id() returns text
language sql stable security definer set search_path = '' as $$
  select case when public.is_admin() then public.campaign_id_peek(public.current_org_id())::text end
$$;

-- Each organization's counter: just after its first unbroken run of numbers from its start.
insert into public.campaign_id_counters (org_id, start_number, next_number)
select o.id, public.campaign_id_start(o.id),
       (with recursive walk(n) as (
          select min(c.id::bigint) from public.campaigns c
          where c.org_id = o.id and c.id ~ '^\d{1,12}$' and c.id::bigint >= public.campaign_id_start(o.id)
          union all
          select w.n + 1 from walk w where exists (select 1 from public.campaigns c where c.org_id = o.id and c.id = (w.n + 1)::text)
        )
        select coalesce(max(n) + 1, public.campaign_id_start(o.id)) from walk)
from public.organizations o
on conflict (org_id) do nothing;

revoke execute on function public.campaign_id_start(uuid) from public, anon, authenticated;
revoke execute on function public.campaign_id_counter(uuid) from public, anon, authenticated;
revoke execute on function public.campaign_id_peek(uuid) from public, anon, authenticated;
revoke execute on function public.campaign_id_take(uuid) from public, anon, authenticated;
