-- Phase 5, part 4: Donary machine registry, assignment history and day booking. The Jewish calendar itself
-- is worked out in the browser, so nothing here depends on it. Routing webhooks to machines is Phase 9.
-- No balance changes here.

-- "Today" where the organization is, not UTC.
create or replace function public.org_today() returns date
language sql stable set search_path = '' as $$
  select (now() at time zone coalesce(
    (select s.value #>> '{}' from public.settings s where s.org_id = public.current_org_id() and s.key = 'timezone'),
    'America/New_York'))::date
$$;

-- ---------------------------------------------------------------------------
-- The registry. Changed only through the functions below, so history can't be skipped.
-- ---------------------------------------------------------------------------
create table public.machines (
  id           text not null default public.short_id(),
  org_id       uuid not null default public.current_org_id() references public.organizations(id),
  nickname     integer not null check (nickname > 0),
  donary_id    text not null check (trim(donary_id) <> ''),
  source_id    text,
  campaign_id  text,
  active       boolean not null default true,
  notes        text,
  retired_at   timestamptz,
  created_by   text default public.current_email(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (org_id, id),
  unique (org_id, nickname),
  foreign key (org_id, source_id) references public.sources (org_id, id) on update cascade on delete set null (source_id),
  foreign key (org_id, campaign_id) references public.campaigns (org_id, id) on update cascade
);
create unique index machines_donary_id on public.machines (org_id, lower(donary_id));
create index machines_org_source_idx on public.machines (org_id, source_id);
create index machines_org_campaign_idx on public.machines (org_id, campaign_id);

-- Every number a machine has ever had. A number is never given to a different machine.
create table public.machine_nicknames (
  org_id     uuid not null references public.organizations(id),
  nickname   integer not null,
  machine_id text not null,
  used_from  timestamptz not null default now(),
  primary key (org_id, nickname),
  foreign key (org_id, machine_id) references public.machines (org_id, id)
);
create index machine_nicknames_org_machine_idx on public.machine_nicknames (org_id, machine_id);

-- Permanent. Nobody can edit or remove an entry.
create table public.machine_assignments (
  id            text not null default public.short_id(),
  org_id        uuid not null references public.organizations(id),
  machine_id    text not null,
  from_campaign text,
  to_campaign   text,
  note          text,
  changed_by    text default public.current_email(),
  changed_at    timestamptz not null default clock_timestamp(),
  primary key (org_id, id),
  foreign key (org_id, machine_id) references public.machines (org_id, id),
  foreign key (org_id, from_campaign) references public.campaigns (org_id, id) on update cascade,
  foreign key (org_id, to_campaign) references public.campaigns (org_id, id) on update cascade
);
create index machine_assignments_org_machine_idx on public.machine_assignments (org_id, machine_id, changed_at desc);
create index machine_assignments_org_from_idx on public.machine_assignments (org_id, from_campaign);
create index machine_assignments_org_to_idx on public.machine_assignments (org_id, to_campaign);

-- Machines already in use are sources named like "Oizer #6", with the Donary ID as the source ID.
insert into public.machines (org_id, nickname, donary_id, source_id, created_by)
select s.org_id, (substring(s.name from '#\s*(\d+)\s*$'))::int, s.id, s.id, 'migration'
from public.sources s
where s.deleted_at is null and s.id ~ '^DP_' and s.name ~ '#\s*\d+\s*$'
on conflict do nothing;
insert into public.machine_nicknames (org_id, nickname, machine_id)
select org_id, nickname, id from public.machines;

create or replace function public.register_machine(
  p_donary_id text, p_nickname integer default null, p_campaign text default null, p_notes text default null, p_source text default null
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  v_number integer := p_nickname;
  v_id text;
begin
  perform public.require_admin();
  if nullif(trim(p_donary_id), '') is null then raise exception 'Enter the Donary machine ID'; end if;
  if exists (select 1 from public.machines m where m.org_id = v_org and lower(m.donary_id) = lower(trim(p_donary_id))) then
    raise exception 'That Donary machine is already registered';
  end if;
  perform pg_advisory_xact_lock(hashtext('machine_numbers:' || v_org::text));
  if v_number is null then
    select coalesce(max(n.nickname), 0) + 1 into v_number from public.machine_nicknames n where n.org_id = v_org;
  elsif exists (select 1 from public.machine_nicknames n where n.org_id = v_org and n.nickname = v_number) then
    raise exception 'Number % has already been used by a machine and can''t be used again', v_number;
  end if;
  insert into public.machines (org_id, nickname, donary_id, source_id, notes)
  values (v_org, v_number, trim(p_donary_id), p_source, nullif(trim(p_notes), ''))
  returning id into v_id;
  insert into public.machine_nicknames (org_id, nickname, machine_id) values (v_org, v_number, v_id);
  if p_campaign is not null then perform public.assign_machine(v_id, p_campaign); end if;
  return v_id;
end $$;

create or replace function public.update_machine(p_machine text, p_nickname integer, p_donary_id text, p_notes text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  m public.machines;
begin
  perform public.require_admin();
  select * into m from public.machines where org_id = v_org and id = p_machine for update;
  if m.id is null then raise exception 'Machine not found'; end if;
  if nullif(trim(p_donary_id), '') is null then raise exception 'Enter the Donary machine ID'; end if;
  if p_nickname is distinct from m.nickname then
    if not m.active then raise exception 'A retired machine keeps its number'; end if;
    perform pg_advisory_xact_lock(hashtext('machine_numbers:' || v_org::text));
    -- A machine may go back to a number of its own, which is how a typo gets fixed.
    if exists (select 1 from public.machine_nicknames n where n.org_id = v_org and n.nickname = p_nickname and n.machine_id <> p_machine) then
      raise exception 'Number % has already been used by a machine and can''t be used again', p_nickname;
    end if;
    insert into public.machine_nicknames (org_id, nickname, machine_id) values (v_org, p_nickname, p_machine) on conflict do nothing;
  end if;
  if exists (select 1 from public.machines x where x.org_id = v_org and x.id <> p_machine and lower(x.donary_id) = lower(trim(p_donary_id))) then
    raise exception 'That Donary machine is already registered';
  end if;
  update public.machines set nickname = p_nickname, donary_id = trim(p_donary_id), notes = nullif(trim(p_notes), '')
  where org_id = v_org and id = p_machine;
end $$;

-- Takes effect at once for anything that follows. Empty p_campaign leaves the machine unassigned.
create or replace function public.assign_machine(p_machine text, p_campaign text, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  m public.machines;
begin
  perform public.require_admin();
  select * into m from public.machines where org_id = v_org and id = p_machine for update;
  if m.id is null then raise exception 'Machine not found'; end if;
  if not m.active then raise exception 'Machine % is retired', m.nickname; end if;
  if p_campaign is not distinct from m.campaign_id then return; end if;
  if p_campaign is not null and not exists (
    select 1 from public.campaigns c where c.org_id = v_org and c.id = p_campaign and c.status = 'active' and c.deleted_at is null) then
    raise exception 'A machine can only be assigned to an active campaign';
  end if;
  update public.machines set campaign_id = p_campaign where org_id = v_org and id = p_machine;
  insert into public.machine_assignments (org_id, machine_id, from_campaign, to_campaign, note)
  values (v_org, p_machine, m.campaign_id, p_campaign, nullif(trim(p_note), ''));
end $$;

create or replace function public.set_machine_active(p_machine text, p_active boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  m public.machines;
begin
  perform public.require_admin();
  select * into m from public.machines where org_id = v_org and id = p_machine for update;
  if m.id is null then raise exception 'Machine not found'; end if;
  if m.active = p_active then return; end if;
  if not p_active then
    if exists (select 1 from public.machine_bookings b where b.org_id = v_org and b.machine_id = p_machine
               and b.status = 'confirmed' and b.booking_date >= public.org_today()) then
      raise exception 'Machine % has confirmed bookings coming up. Cancel them or give them another machine first', m.nickname;
    end if;
    if m.campaign_id is not null then
      insert into public.machine_assignments (org_id, machine_id, from_campaign, to_campaign, note)
      values (v_org, p_machine, m.campaign_id, null, 'Machine retired');
    end if;
  end if;
  update public.machines
  set active = p_active, retired_at = case when p_active then null else now() end,
      campaign_id = case when p_active then campaign_id else null end
  where org_id = v_org and id = p_machine;
end $$;

-- ---------------------------------------------------------------------------
-- Booking: a request for any machine on a day, first come, first served
-- ---------------------------------------------------------------------------
create table public.machine_bookings (
  id             text not null default public.short_id(),
  org_id         uuid not null references public.organizations(id),
  booking_date   date not null,
  campaign_id    text not null,
  manager_id     text,
  notes          text,
  status         text not null default 'pending' check (status in ('pending','confirmed','waitlisted','cancelled')),
  machine_id     text,
  admin_notes    text,
  requested_by   text default public.current_email(),
  requested_at   timestamptz not null default clock_timestamp(),
  -- The place in line. Starts as requested_at, which never changes. Only an admin's override moves it.
  queue_at       timestamptz not null default clock_timestamp(),
  priority_note  text,
  offered_at     timestamptz,
  confirmed_at   timestamptz,
  confirmed_by   text,
  cancelled_at   timestamptz,
  cancelled_by   text,
  cancel_reason  text,
  primary key (org_id, id),
  foreign key (org_id, campaign_id) references public.campaigns (org_id, id) on update cascade,
  foreign key (org_id, manager_id) references public.managers (org_id, id) on update cascade,
  foreign key (org_id, machine_id) references public.machines (org_id, id)
);
create index machine_bookings_org_date_idx on public.machine_bookings (org_id, booking_date, queue_at);
create index machine_bookings_org_campaign_idx on public.machine_bookings (org_id, campaign_id);
create index machine_bookings_org_manager_idx on public.machine_bookings (org_id, manager_id);
create index machine_bookings_org_machine_idx on public.machine_bookings (org_id, machine_id);
create unique index machine_bookings_one_per_day on public.machine_bookings (org_id, booking_date, machine_id) where status = 'confirmed';

create or replace function public.require_booking_user() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (public.is_admin() or coalesce(public.my_org_role() = 'manager', false)) then
    raise exception 'Only admins and fundraisers can use machine bookings';
  end if;
end $$;

-- What anyone booking may see about a day: counts, never who asked.
create or replace function public.machine_availability(p_from date, p_to date)
returns table (day date, machines integer, booked integer, confirmed integer, waitlisted integer, available integer)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  v_total integer;
begin
  perform public.require_booking_user();
  if p_to < p_from or p_to - p_from > 800 then raise exception 'Choose a shorter date range'; end if;
  select count(*) into v_total from public.machines m where m.org_id = v_org and m.active;
  return query
  select g.d::date, v_total,
         coalesce(b.booked, 0)::int, coalesce(b.confirmed, 0)::int, coalesce(b.waitlisted, 0)::int,
         greatest(v_total - coalesce(b.booked, 0)::int, 0)
  from generate_series(p_from, p_to, interval '1 day') g(d)
  left join (
    select x.booking_date,
           count(*) filter (where x.status in ('pending','confirmed')) as booked,
           count(*) filter (where x.status = 'confirmed') as confirmed,
           count(*) filter (where x.status = 'waitlisted') as waitlisted
    from public.machine_bookings x
    where x.org_id = v_org and x.booking_date between p_from and p_to
    group by 1
  ) b on b.booking_date = g.d::date
  order by 1;
end $$;

create or replace function public.lock_machine_day(p_date date) returns void
language sql set search_path = '' as $$
  select pg_advisory_xact_lock(hashtext('machine_day:' || public.current_org_id()::text || ':' || p_date::text))
$$;

create or replace function public.request_machine(p_date date, p_campaign text, p_notes text default null) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  c public.campaigns;
  v_manager text;
  v_status text := 'pending';
  v_id text;
begin
  perform public.require_booking_user();
  if p_date is null or p_date < public.org_today() then raise exception 'Choose today or a later date'; end if;
  select * into c from public.campaigns where org_id = v_org and id = p_campaign and deleted_at is null and status <> 'closed';
  if c.id is null then raise exception 'Choose an open campaign'; end if;
  if public.is_admin() then
    v_manager := c.manager_id;
  else
    if not (p_campaign = any(public.my_campaign_ids())) then raise exception 'That campaign isn''t yours'; end if;
    v_manager := case when c.manager_id = any(public.my_manager_ids()) then c.manager_id else (public.my_manager_ids())[1] end;
  end if;
  perform public.lock_machine_day(p_date);
  if (select count(*) from public.machine_bookings b where b.org_id = v_org and b.booking_date = p_date and b.status in ('pending','confirmed'))
     >= (select count(*) from public.machines m where m.org_id = v_org and m.active) then
    v_status := 'waitlisted';
  end if;
  insert into public.machine_bookings (org_id, booking_date, campaign_id, manager_id, notes, status)
  values (v_org, p_date, p_campaign, v_manager, nullif(trim(p_notes), ''), v_status)
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.confirm_booking(p_booking text, p_machine text, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  b public.machine_bookings;
  m public.machines;
begin
  perform public.require_admin();
  select * into b from public.machine_bookings where org_id = v_org and id = p_booking;
  if b.id is null then raise exception 'Booking not found'; end if;
  perform public.lock_machine_day(b.booking_date);
  select * into b from public.machine_bookings where org_id = v_org and id = p_booking;
  if b.status = 'cancelled' then raise exception 'This request was cancelled'; end if;
  if b.booking_date < public.org_today() then raise exception 'That day has passed'; end if;
  select * into m from public.machines where org_id = v_org and id = p_machine;
  if m.id is null then raise exception 'Choose a machine'; end if;
  if not m.active then raise exception 'Machine % is retired', m.nickname; end if;
  if exists (select 1 from public.machine_bookings x where x.org_id = v_org and x.booking_date = b.booking_date
             and x.machine_id = p_machine and x.status = 'confirmed' and x.id <> p_booking) then
    raise exception 'Machine % is already taken that day', m.nickname;
  end if;
  if b.status <> 'confirmed' and exists (
    select 1 from public.machine_bookings x where x.org_id = v_org and x.booking_date = b.booking_date
    and x.status in ('pending','waitlisted') and x.queue_at < b.queue_at) then
    raise exception 'An earlier request for this day comes first. To go ahead of it, move this one up and give a reason';
  end if;
  update public.machine_bookings
  set status = 'confirmed', machine_id = p_machine, confirmed_at = now(), confirmed_by = public.current_email(),
      admin_notes = coalesce(nullif(trim(p_note), ''), admin_notes)
  where org_id = v_org and id = p_booking;
  -- With every machine out, whoever's still waiting goes on the waitlist.
  if (select count(*) from public.machine_bookings x where x.org_id = v_org and x.booking_date = b.booking_date and x.status = 'confirmed')
     >= (select count(*) from public.machines a where a.org_id = v_org and a.active) then
    update public.machine_bookings set status = 'waitlisted'
    where org_id = v_org and booking_date = b.booking_date and status = 'pending';
  end if;
end $$;

create or replace function public.waitlist_booking(p_booking text, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  perform public.require_admin();
  update public.machine_bookings
  set status = 'waitlisted', admin_notes = coalesce(nullif(trim(p_note), ''), admin_notes)
  where org_id = v_org and id = p_booking and status = 'pending';
  if not found then raise exception 'Only a request that''s still waiting can be waitlisted'; end if;
end $$;

-- Cancelling frees a place, so the next one on the waitlist goes back to the admin to be offered it.
create or replace function public.cancel_booking(p_booking text, p_reason text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  b public.machine_bookings;
  v_next text;
begin
  perform public.require_booking_user();
  select * into b from public.machine_bookings where org_id = v_org and id = p_booking;
  if b.id is null then raise exception 'Booking not found'; end if;
  if not public.is_admin() then
    if not (coalesce(b.manager_id = any(public.my_manager_ids()), false) or b.campaign_id = any(public.my_campaign_ids())) then
      raise exception 'That booking isn''t yours';
    end if;
    if b.booking_date < public.org_today() then raise exception 'That day has passed'; end if;
  end if;
  perform public.lock_machine_day(b.booking_date);
  select * into b from public.machine_bookings where org_id = v_org and id = p_booking;
  if b.status = 'cancelled' then raise exception 'This request was already cancelled'; end if;
  update public.machine_bookings
  set status = 'cancelled', cancelled_at = now(), cancelled_by = public.current_email(), cancel_reason = nullif(trim(p_reason), '')
  where org_id = v_org and id = p_booking;
  if b.status in ('pending','confirmed') and b.booking_date >= public.org_today()
     and (select count(*) from public.machine_bookings x where x.org_id = v_org and x.booking_date = b.booking_date and x.status in ('pending','confirmed'))
         < (select count(*) from public.machines m where m.org_id = v_org and m.active) then
    select x.id into v_next from public.machine_bookings x
    where x.org_id = v_org and x.booking_date = b.booking_date and x.status = 'waitlisted'
    order by x.queue_at, x.id limit 1;
    if v_next is not null then
      update public.machine_bookings set status = 'pending', offered_at = now() where org_id = v_org and id = v_next;
    end if;
  end if;
end $$;

-- The override: swaps places with the neighbor still waiting. The reason lands in the activity log.
create or replace function public.move_booking(p_booking text, p_up boolean, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  b public.machine_bookings;
  n public.machine_bookings;
begin
  perform public.require_admin();
  if nullif(trim(p_reason), '') is null then raise exception 'Give a reason for changing the order'; end if;
  select * into b from public.machine_bookings where org_id = v_org and id = p_booking;
  if b.id is null then raise exception 'Booking not found'; end if;
  perform public.lock_machine_day(b.booking_date);
  select * into b from public.machine_bookings where org_id = v_org and id = p_booking;
  if b.status not in ('pending','waitlisted') then raise exception 'Only a request that''s still waiting can be moved'; end if;
  select * into n from public.machine_bookings x
  where x.org_id = v_org and x.booking_date = b.booking_date and x.status in ('pending','waitlisted') and x.id <> b.id
    and ((p_up and x.queue_at < b.queue_at) or (not p_up and x.queue_at > b.queue_at))
  order by case when p_up then x.queue_at end desc, case when not p_up then x.queue_at end asc limit 1;
  if n.id is null then raise exception 'It''s already %', case when p_up then 'first' else 'last' end; end if;
  update public.machine_bookings set queue_at = n.queue_at, priority_note = trim(p_reason) where org_id = v_org and id = b.id;
  update public.machine_bookings set queue_at = b.queue_at where org_id = v_org and id = n.id;
end $$;

create or replace function public.set_booking_note(p_booking text, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_admin();
  update public.machine_bookings set admin_notes = nullif(trim(p_note), '') where org_id = public.current_org_id() and id = p_booking;
  if not found then raise exception 'Booking not found'; end if;
end $$;

-- A fundraiser sees the number of the machine they got, and their place in line, but not the registry
-- or anyone else's request.
create or replace function public.machine_number(p_machine text) returns integer
language sql stable security definer set search_path = '' as $$
  select m.nickname from public.machines m where m.org_id = public.current_org_id() and m.id = p_machine
$$;

create or replace function public.booking_position(p_date date, p_queue_at timestamptz) returns integer
language sql stable security definer set search_path = '' as $$
  select count(*)::int + 1 from public.machine_bookings x
  where x.org_id = public.current_org_id() and x.booking_date = p_date and x.status <> 'cancelled' and x.queue_at < p_queue_at
$$;

create view public.machine_booking_list with (security_invoker = true) as
select b.id, b.org_id, b.booking_date, b.campaign_id, b.manager_id, b.notes, b.status, b.machine_id, b.admin_notes,
       b.requested_by, b.requested_at, b.queue_at, b.offered_at, b.confirmed_at, b.confirmed_by,
       b.cancelled_at, b.cancelled_by, b.cancel_reason,
       case when (select public.is_admin()) then b.priority_note end as priority_note,
       public.machine_number(b.machine_id) as machine_nickname,
       case when b.status <> 'cancelled' then public.booking_position(b.booking_date, b.queue_at) end as queue_position,
       coalesce(c.internal_name, c.campaign_name, c.external_name) as campaign_name,
       m.full_name as fundraiser,
       b.booking_date < public.org_today() as past
from public.machine_bookings b
left join public.campaigns c on c.org_id = b.org_id and c.id = b.campaign_id
left join public.managers m on m.org_id = b.org_id and m.id = b.manager_id;

revoke all on public.machine_booking_list from anon;
grant select on public.machine_booking_list to authenticated;

-- ---------------------------------------------------------------------------
-- Waiting booking requests reach the Task Sheet
-- ---------------------------------------------------------------------------
create or replace view public.admin_task_sheet with (security_invoker = true) as
with items as (
  select r.org_id, 'campaign_request:' || r.id as task_key,
         case when r.resubmitted_at is null then 'campaign_request' else 'changes_resubmitted' end as task_type,
         r.id as record_id, r.parent_campaign_id as campaign_id, m.full_name as fundraiser, r.goal as amount,
         coalesce(r.resubmitted_at, r.created_at) as submitted_at,
         r.name || case when r.parent_campaign_id is not null then ' (sub-campaign of ' || r.parent_campaign_id || ')' else '' end as summary
  from public.campaign_requests r
  left join public.managers m on m.org_id = r.org_id and m.id = r.manager_id
  where r.status = 'pending'
  union all
  select t.org_id, 'team_request:' || t.id, 'team_request', t.id, t.campaign_id, t.requested_by_email, null,
         t.created_at, coalesce(t.person_name, t.email, t.phone) || ' as ' || t.role
  from public.campaign_team_requests t where t.status = 'pending'
  union all
  select d.org_id, 'pending_payment:' || d.id, 'pending_payment', d.id, d.campaign_id, m.full_name, d.amount,
         d.created_at, coalesce(d.payment_method, 'Payment') || coalesce(' from ' || nullif(d.name, ''), '')
  from public.donations d
  left join public.campaigns c on c.org_id = d.org_id and c.id = d.campaign_id
  left join public.managers m on m.org_id = c.org_id and m.id = c.manager_id
  where d.status = 'pending' and d.deleted_at is null
  union all
  select d.org_id, 'unattributed:' || d.id, 'unattributed', d.id, null, null, d.amount,
         d.created_at, coalesce(d.payment_method, 'Payment') || coalesce(' from ' || nullif(d.name, ''), '') || coalesce(' · ref ' || d.batch_id, '')
  from public.donations d
  where d.campaign_id is null and d.status in ('completed','collect') and d.deleted_at is null
  union all
  select d.org_id, 'returned_check:' || d.id, 'returned_check', d.id, d.campaign_id, m.full_name, d.amount,
         d.reversal_date::timestamptz, 'Check' || coalesce(' #' || d.check_number, '') || coalesce(' from ' || nullif(d.name, ''), '') || coalesce(' · ' || d.reversal_reason, '')
  from public.donations d
  left join public.campaigns c on c.org_id = d.org_id and c.id = d.campaign_id
  left join public.managers m on m.org_id = c.org_id and m.id = c.manager_id
  where d.status = 'returned' and d.reversal_date is not null and d.deleted_at is null
  union all
  select d.org_id, 'post_dated_due:' || d.id, 'post_dated_due', d.id, d.campaign_id, m.full_name, d.amount,
         d.check_date::timestamptz, 'Check' || coalesce(' #' || d.check_number, '') || coalesce(' from ' || nullif(d.name, ''), '') || ' is ready to deposit'
  from public.donations d
  left join public.campaigns c on c.org_id = d.org_id and c.id = d.campaign_id
  left join public.managers m on m.org_id = c.org_id and m.id = c.manager_id
  where d.post_dated and d.check_date <= current_date and d.status = 'completed' and d.deleted_at is null
  union all
  select v.org_id, 'voucher_overdue:' || v.id || ':' || coalesce(v.expected_date::text, ''), 'voucher_overdue', v.id, v.campaign_id, m.full_name, v.remaining,
         coalesce(v.expected_date, v.date_received + 30)::timestamptz,
         v.id || coalesce(' · issuer #' || v.issuer_number, '') || ' · ' || replace(v.issuer, 'Voucher — ', '') || coalesce(' · ' || v.donor_name, '') || ' · face ' || v.face_value
  from public.voucher_list v
  left join public.campaigns c on c.org_id = v.org_id and c.id = v.campaign_id
  left join public.managers m on m.org_id = c.org_id and m.id = c.manager_id
  where v.overdue
  union all
  select p.org_id, 'pledge_overdue:' || p.id || ':' || coalesce(p.next_due_date, p.expected_date)::text, 'pledge_overdue', p.id, p.campaign_id, m.full_name, p.balance,
         coalesce(p.next_due_date, p.expected_date)::timestamptz, p.reference || coalesce(' · ' || p.donor_name, '')
  from public.pledge_list p
  left join public.campaigns c on c.org_id = p.org_id and c.id = p.campaign_id
  left join public.managers m on m.org_id = c.org_id and m.id = c.manager_id
  where p.status = 'overdue'
  union all
  select e.org_id, 'stale_check:' || e.id, 'stale_check', e.id, e.campaign_id, m.full_name, e.amount,
         e.created_at, 'Check' || coalesce(' #' || e.check_number, '') || coalesce(' to ' || nullif(e.payee, ''), '')
  from public.expenses e
  left join public.campaigns c on c.org_id = e.org_id and c.id = e.campaign_id
  left join public.managers m on m.org_id = c.org_id and m.id = c.manager_id
  where e.method = 'Check' and e.cleared is not true and e.deleted_at is null
    and e.created_at < now() - make_interval(days => coalesce(
      (select (s.value #>> '{}')::int from public.settings s where s.org_id = e.org_id and s.key = 'stale_check_days'), 90))
  union all
  select c.org_id, 'inactive_campaign:' || c.id || ':' || coalesce(a.last_at, c.created_at)::date, 'inactive_campaign', c.id, c.id, m.full_name, null,
         coalesce(a.last_at, c.created_at), 'No activity since ' || coalesce(a.last_at, c.created_at)::date
  from public.campaigns c
  left join public.managers m on m.org_id = c.org_id and m.id = c.manager_id
  left join lateral (
    select greatest((select max(d.created_at) from public.donations d where d.org_id = c.org_id and d.campaign_id = c.id and d.deleted_at is null),
                    (select max(e.created_at) from public.expenses e where e.org_id = c.org_id and e.campaign_id = c.id and e.deleted_at is null)) as last_at
  ) a on true
  where c.status = 'active' and c.deleted_at is null
    and coalesce(a.last_at, c.created_at) < now() - make_interval(days => coalesce(
      (select (s.value #>> '{}')::int from public.settings s where s.org_id = c.org_id and s.key = 'inactive_campaign_days'), 90))
  union all
  select c.org_id, 'bank_reassign:' || c.id, 'bank_reassign', c.id, c.id, m.full_name, null,
         a.deleted_at, 'Its bank account "' || a.name || '" was removed'
  from public.removed_accounts() a
  join public.campaigns c on c.org_id = a.org_id and c.account_id = a.id
  left join public.managers m on m.org_id = c.org_id and m.id = c.manager_id
  where c.deleted_at is null and c.status <> 'closed'
  union all
  select b.org_id, 'machine_booking:' || b.id, 'machine_booking', b.id, b.campaign_id, m.full_name, null,
         b.requested_at,
         'Machine for ' || to_char(b.booking_date, 'FMMonth FMDD, YYYY') || case when b.offered_at is not null then ' · a machine opened up' else '' end
  from public.machine_bookings b
  left join public.managers m on m.org_id = b.org_id and m.id = b.manager_id
  where b.status = 'pending' and b.booking_date >= public.org_today()
)
select i.task_key, i.task_type, i.record_id, i.campaign_id, c.internal_name as campaign_name, i.fundraiser, i.amount, i.submitted_at, i.summary,
       h.note as held_note, h.task_key is not null as held
from items i
left join public.campaigns c on c.org_id = i.org_id and c.id = i.campaign_id
left join lateral (
  select a.task_key, a.note from public.task_sheet_actions a
  where a.org_id = i.org_id and a.task_key = i.task_key and a.action = 'held' order by a.created_at desc limit 1
) h on true
where (select public.is_admin())
  and not exists (select 1 from public.task_sheet_actions a where a.org_id = i.org_id and a.task_key = i.task_key and a.action = 'dismissed');

-- ---------------------------------------------------------------------------
-- Row-level security and function access
-- ---------------------------------------------------------------------------
alter table public.machines            enable row level security;
alter table public.machine_nicknames   enable row level security;
alter table public.machine_assignments enable row level security;
alter table public.machine_bookings    enable row level security;
revoke all on public.machines, public.machine_nicknames, public.machine_assignments, public.machine_bookings from anon;
revoke insert, update, delete on public.machines, public.machine_nicknames, public.machine_assignments, public.machine_bookings from authenticated;

do $$
declare t text;
begin
  foreach t in array array['machines','machine_nicknames','machine_assignments','machine_bookings'] loop
    execute format('create policy org_wall on public.%I as restrictive for all to authenticated
                    using (org_id = (select public.current_org_id()))
                    with check (org_id = (select public.current_org_id()))', t);
    execute format('create policy admin_read on public.%I for select to authenticated using ((select public.is_admin()))', t);
  end loop;
  foreach t in array array['machines','machine_assignments','machine_bookings'] loop
    execute format('create trigger log_row_change after insert or update or delete on public.%I
                    for each row execute function public.log_row_change()', t);
  end loop;
end $$;

create trigger touch_updated_at before update on public.machines for each row execute function public.touch_updated_at();

create policy manager_read on public.machine_bookings for select to authenticated
  using (manager_id = any((select public.my_manager_ids())::text[])
         or campaign_id = any((select public.my_campaign_ids())::text[]));

revoke execute on function public.lock_machine_day(date) from public, anon, authenticated;
revoke execute on function public.require_booking_user() from public, anon, authenticated;
do $$
declare f text;
begin
  foreach f in array array[
    'org_today()',
    'register_machine(text, integer, text, text, text)',
    'update_machine(text, integer, text, text)',
    'assign_machine(text, text, text)',
    'set_machine_active(text, boolean)',
    'machine_availability(date, date)',
    'request_machine(date, text, text)',
    'confirm_booking(text, text, text)',
    'waitlist_booking(text, text)',
    'cancel_booking(text, text)',
    'move_booking(text, boolean, text)',
    'set_booking_note(text, text)',
    'machine_number(text)',
    'booking_position(date, timestamptz)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
