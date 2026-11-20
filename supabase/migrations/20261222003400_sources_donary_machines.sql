-- One list for sources and Donary machines (Shulim, 2026-11-13): a Donary machine is a mobile source.
-- Sources get a donary_machine field. A source marked as one has its machine record (number, Donary ID, the campaign
-- it's set to remotely with its assignment history, and its bookings to fundraisers by date), so every existing
-- machine feature keeps working, keyed as before. The field follows the machine: on while it's active, off once it's
-- retired (history stays). Existing machines are linked to a source (the one already named after the Donary machine,
-- else a new one) and keep their assignments and bookings exactly as they are.
alter table public.sources add column if not exists donary_machine boolean not null default false;

-- The source for a Donary machine: the existing source whose key or name is the machine's Donary ID (including the
-- AS-SRC- keys of imported sources), else a new source with that key, named after the machine.
create or replace function public.machine_source_for(p_org uuid, p_donary_id text, p_nickname integer) returns text
language plpgsql security definer set search_path = '' as $$
declare v_id text;
begin
  select s.id into v_id from public.sources s
  where s.org_id = p_org and s.deleted_at is null
    and (lower(s.id) = lower(p_donary_id) or lower(s.name) = lower(p_donary_id) or lower(s.id) = lower('AS-SRC-' || p_donary_id))
    and not exists (select 1 from public.machines m where m.org_id = p_org and m.source_id = s.id)
  order by (lower(s.id) = lower(p_donary_id)) desc, s.id limit 1;
  if v_id is null then
    v_id := p_donary_id;
    if exists (select 1 from public.sources s where s.org_id = p_org and s.id = v_id) then v_id := v_id || '-machine-' || p_nickname; end if;
    insert into public.sources (org_id, id, name) values (p_org, v_id, 'Donary machine ' || p_nickname);
  end if;
  return v_id;
end $$;
revoke execute on function public.machine_source_for(uuid, text, integer) from public, anon, authenticated;

-- Existing machines: each gets its source.
do $$
declare m record;
begin
  for m in select * from public.machines where source_id is null order by org_id, nickname loop
    update public.machines set source_id = public.machine_source_for(m.org_id, m.donary_id, m.nickname) where org_id = m.org_id and id = m.id;
  end loop;
end $$;
create unique index if not exists machines_one_per_source on public.machines (org_id, source_id) where source_id is not null;

-- The field follows the machine.
create or replace function public.sync_source_machine_flag() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.sources s set donary_machine = exists (
    select 1 from public.machines m where m.org_id = s.org_id and m.source_id = s.id and m.active)
  where s.org_id = coalesce(new.org_id, old.org_id) and s.id in (new.source_id, old.source_id);
  return null;
end $$;
revoke execute on function public.sync_source_machine_flag() from public, anon, authenticated;
drop trigger if exists sync_source_machine_flag on public.machines;
create trigger sync_source_machine_flag after insert or update of source_id, active or delete on public.machines
  for each row execute function public.sync_source_machine_flag();
update public.sources s set donary_machine = exists (select 1 from public.machines m where m.org_id = s.org_id and m.source_id = s.id and m.active);

CREATE OR REPLACE FUNCTION public.register_machine(p_donary_id text, p_nickname integer DEFAULT NULL::integer, p_campaign text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_source text DEFAULT NULL::text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org uuid := public.current_org_id();
  v_number integer := p_nickname;
  v_id text;
  v_source text := p_source;
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
  -- Every machine is a source (Shulim, 2026-11-13): use the given source, else the one already named after this
  -- Donary machine, else a new source for it.
  if v_source is null then v_source := public.machine_source_for(v_org, trim(p_donary_id), v_number); end if;
  insert into public.machines (org_id, nickname, donary_id, source_id, notes)
  values (v_org, v_number, trim(p_donary_id), v_source, nullif(trim(p_notes), ''))
  returning id into v_id;
  insert into public.machine_nicknames (org_id, nickname, machine_id) values (v_org, v_number, v_id);
  if p_campaign is not null then perform public.assign_machine(v_id, p_campaign); end if;
  return v_id;
end $function$;

-- Mark a source as a Donary machine, or not (admins, from Sources). On: its machine is registered (or brought back
-- into service). Off: its machine is retired; assignments and bookings stay on record.
create or replace function public.set_source_donary_machine(p_source text, p_on boolean, p_donary_id text default null, p_nickname integer default null)
returns text language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); s public.sources; m public.machines;
begin
  perform public.require_admin();
  select * into s from public.sources where org_id = v_org and id = p_source and deleted_at is null;
  if s.id is null then raise exception 'Source not found'; end if;
  select * into m from public.machines where org_id = v_org and source_id = p_source;
  if p_on then
    if m.id is not null then
      if not m.active then perform public.set_machine_active(m.id, true); end if;
      return m.id;
    end if;
    return public.register_machine(coalesce(nullif(trim(p_donary_id), ''), s.id), p_nickname, null, null, p_source);
  end if;
  if m.id is not null and m.active then perform public.set_machine_active(m.id, false); end if;
  return m.id;
end $$;
revoke execute on function public.set_source_donary_machine(text, boolean, text, integer) from public, anon;
grant execute on function public.set_source_donary_machine(text, boolean, text, integer) to authenticated;
