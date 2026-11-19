-- Method aliases: moving the gifts in batches (Shulim, 2026-11-19). Saving the alias "Credit Card VISA" → Credit Card
-- failed with "canceling statement due to statement timeout": it moved all ~8,000 gifts inside the save, about a
-- second per thousand with the donation triggers, past signed-in users' 8-second limit.
--
-- Now saving an alias is instant and marks its gifts to move (move_pending). They move in batches of a few hundred:
-- the app runs the batches one after another and shows the progress, and a job every minute finishes any move left
-- pending (a closed page, a lost connection). Fees stay as recorded (oizer.keep_fee, as before), and the original
-- name is kept in payment_method_received. A method change doesn't void receipts (that trigger watches amount,
-- campaign, status, deletion and splits only). An index makes finding an alias's gifts quick.

create index if not exists donations_method_lower on public.donations (org_id, lower(trim(payment_method)));

alter table public.payment_method_aliases add column if not exists move_pending boolean not null default false;
alter table public.payment_method_aliases add column if not exists moved_count integer not null default 0;
alter table public.payment_method_aliases add column if not exists move_started_at timestamptz;
alter table public.payment_method_aliases add column if not exists move_finished_at timestamptz;

-- Saving marks the move; it no longer happens inside the save.
create or replace function public.method_alias_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_name text;
begin
  new.alias := trim(new.alias);
  if new.alias = '' then raise exception 'Enter the name as it comes in'; end if;
  if exists (select 1 from public.payment_methods m where m.org_id = new.org_id and lower(m.name) = lower(new.alias)) then
    raise exception '"%" is already one of your payment methods', new.alias;
  end if;
  if not new.not_a_method then
    select m.name into v_name from public.payment_methods m where m.org_id = new.org_id and lower(m.name) = lower(trim(new.method_name));
    if v_name is null then raise exception 'Choose one of your payment methods'; end if;
    new.method_name := v_name;
  end if;
  -- Saved by a person: live from now on, and its gifts on file are moved in batches.
  -- (A batch updating the move counters isn't a save: nothing below runs for it.)
  if auth.uid() is not null and (tg_op = 'INSERT' or new.method_name is distinct from old.method_name or old.applied_at is null
                                 or new.not_a_method is distinct from old.not_a_method or new.alias is distinct from old.alias) then
    new.applied_at := now();
    new.applied_by := public.current_email();
    if not new.not_a_method then
      new.move_pending := true;
      new.moved_count := 0;
      new.move_started_at := now();
      new.move_finished_at := null;
    end if;
  end if;
  if new.not_a_method then new.move_pending := false; end if;
  return new;
end $$;

drop trigger if exists method_alias_remap on public.payment_method_aliases;

-- One batch: moves up to p_limit of the alias's gifts and says how many moved and how many are left.
create or replace function public.move_alias_gifts(p_alias text, p_limit integer default 400)
returns table (moved integer, remaining integer, total_moved integer, done boolean)
language plpgsql security definer set search_path = '' as $$
declare a public.payment_method_aliases; v_n integer; v_left integer; v_org uuid;
begin
  -- From the app: the alias must be this organization's, and the person allowed to change fees. From the job: any.
  if auth.uid() is not null then
    if not public.has_super_permission('configure_fees') then raise exception 'Only an admin who can change fees can move these gifts'; end if;
    v_org := public.current_org_id();
    select * into a from public.payment_method_aliases x where x.org_id = v_org and x.id = p_alias for update;
  else
    select * into a from public.payment_method_aliases x where x.id = p_alias for update;
  end if;
  if a.id is null then raise exception 'That alias isn''t here'; end if;
  if not a.move_pending or a.not_a_method or a.method_name is null or a.applied_at is null then
    return query select 0, 0, a.moved_count, true;
    return;
  end if;
  perform set_config('oizer.keep_fee', 'on', true);
  update public.donations d
     set payment_method_received = coalesce(d.payment_method_received, d.payment_method), payment_method = a.method_name
   where d.org_id = a.org_id and d.id in (
     select x.id from public.donations x
     where x.org_id = a.org_id and lower(trim(x.payment_method)) = lower(a.alias)
     limit greatest(least(coalesce(p_limit, 400), 5000), 1));
  get diagnostics v_n = row_count;
  perform set_config('oizer.keep_fee', '', true);
  select count(*) into v_left from public.donations x where x.org_id = a.org_id and lower(trim(x.payment_method)) = lower(a.alias);
  update public.payment_method_aliases x
     set moved_count = x.moved_count + v_n,
         move_pending = v_left > 0,
         move_finished_at = case when v_left = 0 then now() end
   where x.org_id = a.org_id and x.id = a.id;
  if v_left = 0 and a.moved_count + v_n > 0 then
    perform public.write_activity(a.org_id, 'method_alias_applied', 'payment_method_aliases', a.id, null,
      jsonb_build_object('alias', a.alias, 'method', a.method_name, 'gifts_moved', a.moved_count + v_n, 'fees', 'kept as recorded'));
  end if;
  if v_left = 0 then perform public.refresh_no_fee_rule_tasks(a.org_id); end if;
  return query select v_n, v_left, a.moved_count + v_n, v_left = 0;
end $$;
revoke execute on function public.move_alias_gifts(text, integer) from public, anon;
grant execute on function public.move_alias_gifts(text, integer) to authenticated;

-- The Task Sheet's "Map to existing method": saves the alias and returns how many gifts are waiting to move; the app
-- then moves them in batches with move_alias_gifts.
drop function if exists public.map_payment_method(text, text);
create function public.map_payment_method(p_alias text, p_method text)
returns table (alias_id text, to_move integer)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_id text;
begin
  if not public.has_super_permission('configure_fees') then
    raise exception 'Only an admin who can change fees can map payment methods';
  end if;
  insert into public.payment_method_aliases (org_id, alias, method_name, not_a_method)
  values (v_org, trim(p_alias), p_method, false)
  on conflict (org_id, lower(alias)) do update set method_name = excluded.method_name, not_a_method = false
  returning id into v_id;
  return query select v_id, (select count(*)::integer from public.donations d where d.org_id = v_org and lower(trim(d.payment_method)) = lower(trim(p_alias)));
end $$;
revoke execute on function public.map_payment_method(text, text) from public, anon;
grant execute on function public.map_payment_method(text, text) to authenticated;

-- Every minute: finish any move still pending (the page was closed, the connection dropped), in larger batches.
create or replace function public.run_alias_moves() returns void
language plpgsql security definer set search_path = '' as $$
declare a record; r record; v_until timestamptz := clock_timestamp() + interval '40 seconds';
begin
  for a in select x.id from public.payment_method_aliases x where x.move_pending order by x.move_started_at loop
    loop
      select * into r from public.move_alias_gifts(a.id, 2000);
      exit when r.done or r.moved = 0 or clock_timestamp() > v_until;
    end loop;
    exit when clock_timestamp() > v_until;
  end loop;
end $$;
revoke execute on function public.run_alias_moves() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    perform cron.schedule('alias_moves', '* * * * *', $c$select public.run_alias_moves()$c$);
  end if;
end $$;
