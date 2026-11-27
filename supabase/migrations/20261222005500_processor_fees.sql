-- Readiness #14 (2026-11-15): an unknown payment method meant no fee, silently, and every card processor got the
-- one "Credit Card" rate.
--
-- * Fee rules per processor: processor_fee_rules (Sola, Elevon, Donary) + payment method. The order a fee is worked
--   out in: the campaign's own fee deal for that method (as before), then the processor's rule for that method,
--   then the method's rule. The processor is worked out from the gift itself (fee_processor): Elevon's feed (source
--   Cartis), Sola's (source Sola or Cardknox, and cards taken in the app, which carry a Sola reference), Donary's.
-- * A feed that sends the processor's real fee keeps it (Elevon's fee field), instead of the preset.
-- * Completed gifts left with no fee because their method has no rule (or no method at all) are flagged on the
--   Task Sheet, one item per method name with the count and amount, and the item clears itself once the method is
--   added under Payment methods or those gifts get a fee. (Forms only offer listed methods; see the app.)

-- Which processor a gift came through, from what it carries.
create or replace function public.fee_processor(p_source text, p_donary_id text, p_gateway_id text) returns text
language sql immutable set search_path = '' as $$
  select case
    when p_source ilike '%cartis%' or p_source ilike '%elevon%' then 'elevon'
    when p_source ilike 'sola%' or p_source ilike '%cardknox%' then 'sola'
    when p_gateway_id is not null and p_source in ('Manual', 'Online') then 'sola'   -- cards taken in the app go through Sola
    when p_donary_id is not null or p_source ilike '%donary%' then 'donary'
  end
$$;

create table if not exists public.processor_fee_rules (
  id          text not null default public.short_id(),
  org_id      uuid not null default public.current_org_id() references public.organizations(id),
  processor   text not null check (processor in ('sola', 'elevon', 'donary')),
  method_id   text not null,
  fee_type    text not null default 'none' check (fee_type in ('none', 'flat', 'percent', 'percent_flat')),
  fee_percent numeric(6,3) not null default 0 check (fee_percent >= 0),
  fee_flat    numeric(12,2) not null default 0 check (fee_flat >= 0),
  created_at  timestamptz not null default now(),
  primary key (org_id, id),
  unique (org_id, processor, method_id),
  foreign key (org_id, method_id) references public.payment_methods (org_id, id) on delete cascade
);
alter table public.processor_fee_rules enable row level security;
revoke all on public.processor_fee_rules from anon;
grant select, insert, update, delete on public.processor_fee_rules to authenticated;
drop policy if exists org_wall on public.processor_fee_rules;
create policy org_wall on public.processor_fee_rules as restrictive for all to authenticated
  using (org_id = (select public.current_org_id())) with check (org_id = (select public.current_org_id()));
drop policy if exists admin_read on public.processor_fee_rules;
create policy admin_read on public.processor_fee_rules for select to authenticated using ((select public.is_admin()));
drop policy if exists fee_insert on public.processor_fee_rules;
create policy fee_insert on public.processor_fee_rules for insert to authenticated with check ((select public.has_super_permission('configure_fees')));
drop policy if exists fee_update on public.processor_fee_rules;
create policy fee_update on public.processor_fee_rules for update to authenticated using ((select public.has_super_permission('configure_fees')));
drop policy if exists fee_delete on public.processor_fee_rules;
create policy fee_delete on public.processor_fee_rules for delete to authenticated using ((select public.has_super_permission('configure_fees')));

-- The fee: the campaign's deal for the method, else the processor's rule, else the method's rule.
drop function if exists public.calculate_fee(uuid, text, text, numeric);
create or replace function public.calculate_fee(p_org uuid, p_campaign text, p_method text, p_amount numeric, p_processor text default null)
returns numeric
language sql stable security definer set search_path = '' as $$
  with recursive up as (
    select c.id, c.parent_campaign_id, 0 as depth from public.campaigns c where c.org_id = p_org and c.id = p_campaign
    union all
    select c.id, c.parent_campaign_id, up.depth + 1
    from up join public.campaigns c on c.org_id = p_org and c.id = up.parent_campaign_id
  )
  select public.fee_up(case r.fee_type
                 when 'flat' then r.fee_flat
                 when 'percent' then p_amount * r.fee_percent / 100
                 when 'percent_flat' then p_amount * r.fee_percent / 100 + r.fee_flat
                 else 0 end)
  from (
    select coalesce(o.fee_type, pr.fee_type, m.fee_type) fee_type,
           coalesce(o.fee_percent, pr.fee_percent, m.fee_percent) fee_percent,
           coalesce(o.fee_flat, pr.fee_flat, m.fee_flat) fee_flat
    from public.payment_methods m
    left join lateral (
      select f.fee_type, f.fee_percent, f.fee_flat
      from public.campaign_fee_overrides f join up on up.id = f.campaign_id
      where f.org_id = m.org_id and f.method_id = m.id
      order by up.depth limit 1
    ) o on true
    left join public.processor_fee_rules pr on pr.org_id = m.org_id and pr.method_id = m.id and pr.processor = p_processor
    where m.org_id = p_org and lower(m.name) = lower(p_method)
  ) r
$$;
revoke execute on function public.calculate_fee(uuid, text, text, numeric, text) from public, anon;
grant execute on function public.calculate_fee(uuid, text, text, numeric, text) to authenticated, service_role;

-- New gifts and edits pass the gift's processor; the feeds pass the processor's real fee when they send one.
do $$
declare
  v_def text;
  v_new text;
begin
  select pg_get_functiondef(p.oid) into v_def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'donation_defaults';
  v_new := replace(v_def, 'public.calculate_fee(new.org_id, new.campaign_id, new.payment_method, new.amount)',
                   'public.calculate_fee(new.org_id, new.campaign_id, new.payment_method, new.amount, public.fee_processor(new.source, new.donary_id, new.gateway_id))');
  if v_new = v_def then raise exception 'donation_defaults: fee call not found'; end if;
  execute v_new;

  select pg_get_functiondef(p.oid) into v_def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'make_new_donation';
  v_new := replace(replace(v_def,
    'gateway_id, donary_id, anonymous, collector_label, notes, created_at)', 'gateway_id, donary_id, anonymous, collector_label, notes, created_at, fee)'),
    'public.make_time(d ->> ''created_at''));', 'public.make_time(d ->> ''created_at''), public.make_num(d ->> ''fee''));');
  if v_new = v_def or position('created_at, fee)' in v_new) = 0 or position('make_num(d ->> ''fee'')' in v_new) = 0 then
    raise exception 'make_new_donation: insert not found';
  end if;
  execute v_new;

  select pg_get_functiondef(p.oid) into v_def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'make_ingest';
  v_new := replace(v_def, $s$'source', 'Cartis', 'payment_method',$s$,
    $s$'source', 'Cartis', 'fee', coalesce(b ->> 'fee', b ->> 'processing_fee', b ->> 'fee_amount', b -> 'payment_info' ->> 'fee'), 'payment_method',$s$);
  if v_new = v_def then raise exception 'make_ingest: Elevon payment not found'; end if;
  execute v_new;
end $$;

-- Task Sheet: completed gifts with no fee because their method has no rule, one item per method name.
create or replace function public.refresh_no_fee_rule_tasks(p_org uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  with g as (
    -- One item per method name whatever its capitals ("Venmo" and "venmo" are one), named as it's most often written.
    select mode() within group (order by coalesce(nullif(trim(d.payment_method), ''), '')) as method,
           count(*) as n, sum(d.amount) as amount, max(d.created_at) as last_at
    from public.donations d
    where d.org_id = p_org and d.deleted_at is null and d.status = 'completed' and d.fee is null
      and not exists (select 1 from public.payment_methods m where m.org_id = d.org_id and lower(m.name) = lower(trim(d.payment_method)))
    group by lower(coalesce(nullif(trim(d.payment_method), ''), ''))
  ), up as (
    insert into public.task_items (org_id, task_key, task_type, record_id, amount, summary, created_at, resolved_at)
    select p_org, 'no_fee_rule:' || lower(g.method), 'no_fee_rule', nullif(g.method, ''), g.amount,
           case when g.method = '' then g.n || ' completed gift' || case when g.n = 1 then '' else 's' end || ' with no payment method, so no fee'
                else 'Payment method "' || g.method || '" has no fee rule: ' || g.n || ' completed gift' || case when g.n = 1 then '' else 's' end || ' with no fee' end,
           g.last_at, null
    from g
    on conflict (org_id, task_key) do update
      set amount = excluded.amount, summary = excluded.summary, record_id = excluded.record_id, resolved_at = null
    returning task_key
  )
  update public.task_items t set resolved_at = now()
  where t.org_id = p_org and t.task_type = 'no_fee_rule' and t.resolved_at is null
    and t.task_key not in (select task_key from up);
end $$;
revoke execute on function public.refresh_no_fee_rule_tasks(uuid) from public, anon, authenticated;

-- Refreshed when a write could change it: a completed gift without a fee written or changed, or a method added,
-- renamed or removed. Once per statement, so an import is one refresh. Each branch reads only the transition tables
-- its operation has.
create or replace function public.no_fee_rule_check() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  if tg_table_name = 'payment_methods' then
    if tg_op = 'INSERT' then
      for r in select distinct org_id from new_rows loop perform public.refresh_no_fee_rule_tasks(r.org_id); end loop;
    elsif tg_op = 'DELETE' then
      for r in select distinct org_id from old_rows loop perform public.refresh_no_fee_rule_tasks(r.org_id); end loop;
    else
      for r in select distinct org_id from new_rows loop perform public.refresh_no_fee_rule_tasks(r.org_id); end loop;
    end if;
  elsif tg_op = 'INSERT' then
    for r in select distinct org_id from new_rows where status = 'completed' and fee is null loop
      perform public.refresh_no_fee_rule_tasks(r.org_id);
    end loop;
  elsif tg_op = 'DELETE' then
    for r in select distinct org_id from old_rows where status = 'completed' and fee is null loop
      perform public.refresh_no_fee_rule_tasks(r.org_id);
    end loop;
  else
    for r in select distinct org_id from (
               select org_id from new_rows where status = 'completed' and fee is null
               union all
               select org_id from old_rows where status = 'completed' and fee is null) x loop
      perform public.refresh_no_fee_rule_tasks(r.org_id);
    end loop;
  end if;
  return null;
end $$;
revoke execute on function public.no_fee_rule_check() from public, anon, authenticated;

drop trigger if exists no_fee_rule_ins on public.donations;
drop trigger if exists no_fee_rule_upd on public.donations;
drop trigger if exists no_fee_rule_del on public.donations;
drop trigger if exists no_fee_rule_m_ins on public.payment_methods;
drop trigger if exists no_fee_rule_m_upd on public.payment_methods;
drop trigger if exists no_fee_rule_m_del on public.payment_methods;
create trigger no_fee_rule_ins after insert on public.donations referencing new table as new_rows
  for each statement execute function public.no_fee_rule_check();
create trigger no_fee_rule_upd after update on public.donations referencing old table as old_rows new table as new_rows
  for each statement execute function public.no_fee_rule_check();
create trigger no_fee_rule_del after delete on public.donations referencing old table as old_rows
  for each statement execute function public.no_fee_rule_check();
create trigger no_fee_rule_m_ins after insert on public.payment_methods referencing new table as new_rows
  for each statement execute function public.no_fee_rule_check();
create trigger no_fee_rule_m_upd after update on public.payment_methods referencing old table as old_rows new table as new_rows
  for each statement execute function public.no_fee_rule_check();
create trigger no_fee_rule_m_del after delete on public.payment_methods referencing old table as old_rows
  for each statement execute function public.no_fee_rule_check();

-- The flags for what's there now.
do $$
declare r record;
begin
  for r in select id from public.organizations loop perform public.refresh_no_fee_rule_tasks(r.id); end loop;
end $$;
