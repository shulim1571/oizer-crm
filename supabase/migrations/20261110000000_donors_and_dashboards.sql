-- Phase 5, part 3: donor lookup for fundraisers, the contact log, duplicate detection and merging,
-- and the numbers behind the dashboards. No balance changes here.

-- ---------------------------------------------------------------------------
-- Donors
-- ---------------------------------------------------------------------------
drop view public.donor_summary;

alter table public.donors
  add column country text not null default 'US' check (country in ('US','CA','IL','GB')),
  add column merged_into text;

create view public.donor_summary with (security_invoker = true) as
select dn.*,
       coalesce(g.gift_count, 0) as gift_count,
       coalesce(g.total_given, 0) as total_given,
       g.first_gift_at,
       g.last_gift_at,
       g.campaign_count,
       coalesce(p.open_pledges, 0) as open_pledges
from public.donors dn
left join (
  select org_id, donor_id, count(*) as gift_count, sum(amount) as total_given,
         min(created_at) as first_gift_at, max(created_at) as last_gift_at, count(distinct campaign_id) as campaign_count
  from public.donations
  where donor_id is not null and status in ('completed','collect') and deleted_at is null
  group by org_id, donor_id
) g on g.org_id = dn.org_id and g.donor_id = dn.id
left join (
  select l.org_id, l.donor_id, sum(l.balance) as open_pledges
  from public.pledge_list l where l.donor_id is not null and l.status in ('open','partial','overdue')
  group by l.org_id, l.donor_id
) p on p.org_id = dn.org_id and p.donor_id = dn.id
where dn.deleted_at is null;
revoke all on public.donor_summary from anon;
grant select on public.donor_summary to authenticated;

-- A fundraiser who found a donor through lookup, or added one, has them on their list. What they see
-- of that donor's giving is still only their own campaigns'.
create table public.fundraiser_donors (
  org_id     uuid not null references public.organizations(id),
  manager_id text not null,
  donor_id   text not null,
  linked_by  text not null default public.current_email(),
  linked_at  timestamptz not null default now(),
  primary key (org_id, manager_id, donor_id),
  foreign key (org_id, manager_id) references public.managers (org_id, id),
  foreign key (org_id, donor_id) references public.donors (org_id, id)
);
create index fundraiser_donors_org_donor_idx on public.fundraiser_donors (org_id, donor_id);

drop policy manager_read on public.donors;
create policy manager_read on public.donors for select to authenticated
  using (id in (select d.donor_id from public.donations d
                where d.campaign_id = any((select public.my_campaign_ids())::text[]) and d.deleted_at is null)
         or id in (select f.donor_id from public.fundraiser_donors f where f.manager_id = any((select public.my_manager_ids())::text[])));
create policy manager_update on public.donors for update to authenticated
  using (id in (select d.donor_id from public.donations d
                where d.campaign_id = any((select public.my_campaign_ids())::text[]) and d.deleted_at is null)
         or id in (select f.donor_id from public.fundraiser_donors f where f.manager_id = any((select public.my_manager_ids())::text[])));

-- Admin notes and merges stay with admins. A merged donor can't come back: their history has moved.
create or replace function public.donor_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.merged_into is not null and old.deleted_at is not null and new.deleted_at is null then
    raise exception 'This donor was merged into another and can''t be restored';
  end if;
  if auth.uid() is not null and not public.is_admin()
     and (new.notes is distinct from old.notes or new.merged_into is distinct from old.merged_into) then
    raise exception 'Only admins can change that';
  end if;
  return new;
end $$;
create trigger donor_guard before update on public.donors
  for each row execute function public.donor_guard();

-- Searches the whole organization, but only ever answers a specific search, so the list can't be pulled.
create or replace function public.lookup_donors(p_q text)
returns table (id text, display_name text, yiddish_name text, phone text, email text, on_my_list boolean)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  v_q text := trim(coalesce(p_q, ''));
  v_digits text := regexp_replace(v_q, '\D', '', 'g');
begin
  if not public.is_admin() and coalesce(array_length(public.my_manager_ids(), 1), 0) = 0 then
    raise exception 'Only admins and fundraisers can look up donors';
  end if;
  if length(v_q) < 2 then return; end if;
  return query
    select d.id, d.display_name, d.yiddish_name, d.phone, d.email,
           public.is_admin()
           or exists (select 1 from public.fundraiser_donors f where f.org_id = v_org and f.donor_id = d.id and f.manager_id = any(public.my_manager_ids()))
           or exists (select 1 from public.donations x where x.org_id = v_org and x.donor_id = d.id and x.deleted_at is null and x.campaign_id = any(public.my_campaign_ids()))
    from public.donors d
    where d.org_id = v_org and d.deleted_at is null
      and (d.display_name ilike '%' || v_q || '%'
           or d.yiddish_name ilike '%' || v_q || '%'
           or d.id = v_q
           or (length(v_digits) >= 4 and regexp_replace(coalesce(d.phone, ''), '\D', '', 'g') like '%' || v_digits || '%'))
    order by d.display_name
    limit 20;
end $$;

create or replace function public.link_donor(p_donor text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  v_manager text := (public.my_manager_ids())[1];
begin
  if public.is_admin() then return; end if;
  if v_manager is null then raise exception 'Only a fundraiser can link a donor'; end if;
  if not exists (select 1 from public.donors d where d.org_id = v_org and d.id = p_donor and d.deleted_at is null) then
    raise exception 'Donor not found';
  end if;
  insert into public.fundraiser_donors (org_id, manager_id, donor_id) values (v_org, v_manager, p_donor) on conflict do nothing;
end $$;

create or replace function public.add_fundraiser_donor(p_fields jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  v_manager text := (public.my_manager_ids())[1];
  d public.donors := jsonb_populate_record(null::public.donors, p_fields);
  v_id text;
begin
  if v_manager is null then raise exception 'Only a fundraiser can add a donor here'; end if;
  if nullif(trim(d.first_name), '') is null or nullif(trim(d.last_name), '') is null then
    raise exception 'A donor needs a first and last name';
  end if;
  insert into public.donors (org_id, english_title, first_name, last_name, yiddish_title, yiddish_first_name, yiddish_last_name, yiddish_suffix, phone, email, address, country)
  values (v_org, d.english_title, trim(d.first_name), trim(d.last_name), d.yiddish_title, d.yiddish_first_name, d.yiddish_last_name, d.yiddish_suffix, d.phone, d.email, d.address, coalesce(d.country, 'US'))
  returning id into v_id;
  insert into public.fundraiser_donors (org_id, manager_id, donor_id) values (v_org, v_manager, v_id);
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- Contact log: permanent, per donor, and scoped like giving history
-- ---------------------------------------------------------------------------
create table public.donor_contacts (
  id           text not null default public.short_id(),
  org_id       uuid not null references public.organizations(id),
  donor_id     text not null,
  contact_date date not null default current_date,
  method       text not null check (method in ('Call','Email','SMS','In Person')),
  outcome      text not null check (outcome in ('Reached','Voicemail','No Answer','Replied','Meeting Scheduled','Other')),
  notes        text,
  manager_id   text,
  created_by   text not null default public.current_email(),
  created_at   timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, donor_id) references public.donors (org_id, id),
  foreign key (org_id, manager_id) references public.managers (org_id, id)
);
create index donor_contacts_org_donor_idx on public.donor_contacts (org_id, donor_id, contact_date desc);
create index donor_contacts_org_manager_idx on public.donor_contacts (org_id, manager_id);

-- Everyone who shares a campaign with this fundraiser.
create or replace function public.my_team_manager_ids() returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct m), '{}') from (
    select c.manager_id as m from public.campaigns c
    where c.org_id = public.current_org_id() and c.id = any(public.my_campaign_ids())
    union all
    select unnest(c.sub_manager_ids) from public.campaigns c
    where c.org_id = public.current_org_id() and c.id = any(public.my_campaign_ids())
    union all
    select unnest(public.my_manager_ids())
  ) x where m is not null
$$;

create or replace function public.add_donor_contact(p_donor text, p_method text, p_outcome text, p_notes text default null, p_date date default null) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  v_admin boolean := public.is_admin();
  v_id text;
begin
  if not v_admin and not exists (
    select 1 from public.fundraiser_donors f where f.org_id = v_org and f.donor_id = p_donor and f.manager_id = any(public.my_manager_ids())
  ) and not exists (
    select 1 from public.donations d where d.org_id = v_org and d.donor_id = p_donor and d.deleted_at is null and d.campaign_id = any(public.my_campaign_ids())
  ) then
    raise exception 'That donor isn''t on your list';
  end if;
  insert into public.donor_contacts (org_id, donor_id, contact_date, method, outcome, notes, manager_id)
  values (v_org, p_donor, coalesce(p_date, current_date), p_method, p_outcome, nullif(p_notes, ''),
          case when v_admin then null else (public.my_manager_ids())[1] end)
  returning id into v_id;
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- Duplicates and merging
-- ---------------------------------------------------------------------------
create table public.donor_duplicate_dismissals (
  org_id       uuid not null references public.organizations(id),
  match_key    text not null,
  dismissed_by text not null default public.current_email(),
  dismissed_at timestamptz not null default now(),
  primary key (org_id, match_key)
);

create view public.donor_duplicates with (security_invoker = true) as
with keyed as (
  select d.org_id, d.id, d.display_name, d.phone, d.email, 'name:' || lower(trim(d.display_name)) as match_key, 'Same name' as reason
  from public.donors d where d.deleted_at is null and d.display_name <> '(no name)'
  union all
  select d.org_id, d.id, d.display_name, d.phone, d.email, 'phone:' || right(regexp_replace(d.phone, '\D', '', 'g'), 10), 'Same phone'
  from public.donors d where d.deleted_at is null and length(regexp_replace(coalesce(d.phone, ''), '\D', '', 'g')) >= 7
)
select k.match_key, k.reason, count(*) as donor_count,
       jsonb_agg(jsonb_build_object('id', k.id, 'name', k.display_name, 'phone', k.phone, 'email', k.email) order by k.id) as donors
from keyed k
where (select public.is_admin())
  and not exists (select 1 from public.donor_duplicate_dismissals x where x.org_id = k.org_id and x.match_key = k.match_key)
group by k.org_id, k.match_key, k.reason
having count(*) > 1;
revoke all on public.donor_duplicates from anon;
grant select on public.donor_duplicates to authenticated;

create or replace function public.dismiss_donor_duplicate(p_key text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_admin();
  insert into public.donor_duplicate_dismissals (org_id, match_key) values (public.current_org_id(), p_key) on conflict do nothing;
end $$;

create table public.donor_merges (
  id         text not null default public.short_id(),
  org_id     uuid not null references public.organizations(id),
  kept_id    text not null,
  absorbed_id text not null,
  absorbed   jsonb not null,
  merged_by  text not null default public.current_email(),
  merged_at  timestamptz not null default now(),
  primary key (org_id, id)
);

-- Permanent. The survivor keeps its name and details, filling only blanks from the other.
create or replace function public.merge_donors(p_keep text, p_absorb text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  k public.donors;
  a public.donors;
begin
  perform public.require_admin();
  if p_keep = p_absorb then raise exception 'Choose two different donors'; end if;
  select * into k from public.donors where org_id = v_org and id = p_keep and deleted_at is null for update;
  select * into a from public.donors where org_id = v_org and id = p_absorb and deleted_at is null for update;
  if k.id is null or a.id is null then raise exception 'Donor not found'; end if;

  update public.donations set donor_id = p_keep where org_id = v_org and donor_id = p_absorb;
  update public.pledges set donor_id = p_keep where org_id = v_org and donor_id = p_absorb;
  update public.tasks set donor_id = p_keep where org_id = v_org and donor_id = p_absorb;
  update public.vouchers set donor_id = p_keep where org_id = v_org and donor_id = p_absorb;
  update public.donor_contacts set donor_id = p_keep where org_id = v_org and donor_id = p_absorb;

  delete from public.task_call_items i where i.org_id = v_org and i.donor_id = p_absorb
    and exists (select 1 from public.task_call_items o where o.org_id = v_org and o.task_id = i.task_id and o.donor_id = p_keep);
  update public.task_call_items set donor_id = p_keep where org_id = v_org and donor_id = p_absorb;

  insert into public.fundraiser_donors (org_id, manager_id, donor_id, linked_by)
  select org_id, manager_id, p_keep, linked_by from public.fundraiser_donors where org_id = v_org and donor_id = p_absorb
  on conflict do nothing;
  delete from public.fundraiser_donors where org_id = v_org and donor_id = p_absorb;

  update public.donors set
    phone = coalesce(phone, a.phone), email = coalesce(email, a.email), address = coalesce(address, a.address),
    ojc_id = coalesce(ojc_id, a.ojc_id), nadvan_id = coalesce(nadvan_id, a.nadvan_id), matbia_id = coalesce(matbia_id, a.matbia_id),
    pledger_id = coalesce(pledger_id, a.pledger_id),
    notes = case when a.notes is null then notes else concat_ws(E'\n', notes, a.notes) end
  where org_id = v_org and id = p_keep;

  update public.donors set merged_into = p_keep, deleted_at = now(), deleted_by = public.current_email()
  where org_id = v_org and id = p_absorb;

  insert into public.donor_merges (org_id, kept_id, absorbed_id, absorbed)
  values (v_org, p_keep, p_absorb, to_jsonb(a));
end $$;

-- ---------------------------------------------------------------------------
-- Dashboard numbers. Runs under the caller's own access, so a fundraiser's figures are their own.
-- ---------------------------------------------------------------------------
create or replace function public.dashboard_stats(p_from date, p_to date) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  v_tz text;
  v_today date;
  v_since date;
  v_result jsonb;
begin
  select s.value #>> '{}' into v_tz from public.settings s where s.org_id = v_org and s.key = 'timezone';
  v_tz := coalesce(v_tz, 'America/New_York');
  v_today := (now() at time zone v_tz)::date;
  v_since := least(p_from, date_trunc('year', v_today)::date);

  with base as (
    select d.campaign_id, d.source, (d.created_at at time zone v_tz)::date as day,
           case when d.type = 'Payment' then d.amount else coalesce(d.funded, 0) end as raised,
           coalesce(d.fee, 0) as fee
    from public.donations d
    where d.status = 'completed' and d.deleted_at is null and d.created_at >= (v_since::timestamp at time zone v_tz)
  ), ranged as (
    select * from base where day between p_from and p_to
  ), periods as (
    select jsonb_build_object(
      'today', jsonb_build_object('raised', coalesce(sum(raised) filter (where day = v_today), 0), 'fees', coalesce(sum(fee) filter (where day = v_today), 0)),
      'week',  jsonb_build_object('raised', coalesce(sum(raised) filter (where day >= v_today - extract(dow from v_today)::int), 0), 'fees', coalesce(sum(fee) filter (where day >= v_today - extract(dow from v_today)::int), 0)),
      'month', jsonb_build_object('raised', coalesce(sum(raised) filter (where day >= date_trunc('month', v_today)::date), 0), 'fees', coalesce(sum(fee) filter (where day >= date_trunc('month', v_today)::date), 0)),
      'year',  jsonb_build_object('raised', coalesce(sum(raised) filter (where day >= date_trunc('year', v_today)::date), 0), 'fees', coalesce(sum(fee) filter (where day >= date_trunc('year', v_today)::date), 0))
    ) as j from base
  ), totals as (
    select coalesce(sum(s.pledged_open), 0) as pledged, coalesce(sum(s.pledge_scheduled_30), 0) as s30, coalesce(sum(s.pledge_scheduled_90), 0) as s90
    from public.campaign_summary s
  )
  select jsonb_build_object(
    'today', v_today,
    'periods', (select j from periods),
    'range', (select jsonb_build_object('raised', coalesce(sum(raised), 0), 'fees', coalesce(sum(fee), 0), 'count', count(*)) from ranged),
    'daily', (select coalesce(jsonb_agg(jsonb_build_object('day', day, 'total', total) order by day), '[]')
              from (select day, sum(raised) as total from ranged group by day) x),
    'sources', (select coalesce(jsonb_agg(jsonb_build_object('name', name, 'total', total) order by total desc), '[]')
                from (select coalesce(so.name, r.source, 'Unknown') as name, sum(r.raised) as total
                      from ranged r left join public.sources so on so.org_id = v_org and so.id = r.source
                      group by 1 order by 2 desc limit 8) x),
    'top_campaigns', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'total', total) order by total desc), '[]')
                      from (select c.id, c.internal_name as name, sum(r.raised) as total
                            from ranged r join public.campaigns c on c.org_id = v_org and c.id = r.campaign_id
                            group by c.id, c.internal_name order by 3 desc limit 8) x),
    'top_fundraisers', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'total', total) order by total desc), '[]')
                        from (select m.id, m.full_name as name, sum(r.raised) as total
                              from ranged r
                              join public.campaigns c on c.org_id = v_org and c.id = r.campaign_id
                              join public.managers m on m.org_id = v_org and m.id = c.manager_id
                              group by m.id, m.full_name order by 3 desc limit 8) x),
    'pledged', (select pledged from totals),
    'scheduled_30', (select s30 from totals),
    'scheduled_90', (select s90 from totals)
  ) into v_result;
  return v_result;
end $$;

-- ---------------------------------------------------------------------------
-- Row-level security and function access
-- ---------------------------------------------------------------------------
alter table public.fundraiser_donors          enable row level security;
alter table public.donor_contacts             enable row level security;
alter table public.donor_duplicate_dismissals enable row level security;
alter table public.donor_merges               enable row level security;
revoke all on public.fundraiser_donors, public.donor_contacts, public.donor_duplicate_dismissals, public.donor_merges from anon;
-- All through the functions above. Contact log entries are permanent: nobody edits or deletes them.
revoke insert, update, delete on public.fundraiser_donors, public.donor_contacts, public.donor_duplicate_dismissals, public.donor_merges from authenticated;

do $$
declare t text;
begin
  foreach t in array array['fundraiser_donors','donor_contacts','donor_duplicate_dismissals','donor_merges'] loop
    execute format('create policy org_wall on public.%I as restrictive for all to authenticated
                    using (org_id = (select public.current_org_id()))
                    with check (org_id = (select public.current_org_id()))', t);
    execute format('create policy admin_read on public.%I for select to authenticated using ((select public.is_admin()))', t);
    execute format('create trigger log_row_change after insert on public.%I
                    for each row execute function public.log_row_change()', t);
  end loop;
end $$;
create policy own_read on public.fundraiser_donors for select to authenticated
  using (manager_id = any((select public.my_manager_ids())::text[]));
create policy team_read on public.donor_contacts for select to authenticated
  using (manager_id = any((select public.my_team_manager_ids())::text[]));

revoke execute on function public.donor_guard() from public, anon, authenticated;
revoke execute on function public.my_team_manager_ids() from public, anon;
grant execute on function public.my_team_manager_ids() to authenticated;
do $$
declare f text;
begin
  foreach f in array array[
    'lookup_donors(text)',
    'link_donor(text)',
    'add_fundraiser_donor(jsonb)',
    'add_donor_contact(text, text, text, text, date)',
    'dismiss_donor_duplicate(text)',
    'merge_donors(text, text)',
    'dashboard_stats(date, date)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
