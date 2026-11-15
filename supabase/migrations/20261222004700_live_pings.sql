-- Live refresh (Moshe Henig, 2026-11-15): open screens update on their own when data changes.
--
-- Kept light on the database:
-- * Screens listen (Supabase Realtime) to this one small table, never to donations or payouts themselves. A ping
--   carries only the organization, a topic and a time: no amounts, names or other donation data.
-- * Statement-level triggers ping once per insert/update/delete statement and organization, so an import of
--   5,000 rows is one ping, not 5,000.
-- * Append-only: each ping is its own row, so writers never wait on one another (one shared row per organization
--   would make a long import hold up webhook gifts until it finished). Pings older than an hour are cleared now
--   and then by the trigger itself; they only ever mean "look again".
-- * Read access: active members of that organization only. The check is on org_members directly, because Realtime
--   applies row security with the user's sign-in but without the x-org-id header the app's requests carry.

create table if not exists public.live_pings (
  id bigint generated always as identity primary key,
  org_id uuid not null,
  topic text not null check (topic in ('gifts', 'payouts', 'transfers', 'pledges', 'campaigns')),
  at timestamptz not null default now()
);
create index if not exists live_pings_at on public.live_pings (at);

alter table public.live_pings enable row level security;
drop policy if exists member_read on public.live_pings;
create policy member_read on public.live_pings for select to authenticated
  using (exists (select 1 from public.org_members m
                 where m.org_id = live_pings.org_id and m.user_id = (select auth.uid()) and m.status = 'active'));
revoke all on public.live_pings from public, anon, authenticated;
grant select on public.live_pings to authenticated;

create or replace function public.live_ping() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- The rows this statement touched (new rows for insert and update, old rows for delete): one ping per org.
  if tg_op = 'DELETE' then
    insert into public.live_pings (org_id, topic) select distinct org_id, tg_argv[0] from old_rows where org_id is not null;
  else
    insert into public.live_pings (org_id, topic) select distinct org_id, tg_argv[0] from new_rows where org_id is not null;
  end if;
  if random() < 0.02 then
    delete from public.live_pings where at < now() - interval '1 hour';
  end if;
  return null;
end $$;
revoke execute on function public.live_ping() from public, anon, authenticated;

do $$
declare
  t record;
begin
  for t in select * from (values
      ('donations', 'gifts'), ('recurring_donations', 'gifts'),
      ('expenses', 'payouts'), ('checks', 'payouts'), ('payout_requests', 'payouts'),
      ('transfers', 'transfers'), ('bank_transfers', 'transfers'), ('transfer_requests', 'transfers'),
      ('pledges', 'pledges'), ('pledge_payments', 'pledges'), ('pledge_installments', 'pledges'),
      ('campaigns', 'campaigns')) v(tab, topic)
  loop
    execute format('drop trigger if exists live_ping_ins on public.%I', t.tab);
    execute format('drop trigger if exists live_ping_upd on public.%I', t.tab);
    execute format('drop trigger if exists live_ping_del on public.%I', t.tab);
    execute format('create trigger live_ping_ins after insert on public.%I referencing new table as new_rows for each statement execute function public.live_ping(%L)', t.tab, t.topic);
    execute format('create trigger live_ping_upd after update on public.%I referencing new table as new_rows for each statement execute function public.live_ping(%L)', t.tab, t.topic);
    execute format('create trigger live_ping_del after delete on public.%I referencing old table as old_rows for each statement execute function public.live_ping(%L)', t.tab, t.topic);
  end loop;
end $$;

-- Realtime sends new pings to the screens that are listening (only where the publication exists: not in tests).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'live_pings') then
    alter publication supabase_realtime add table public.live_pings;
  end if;
end $$;
