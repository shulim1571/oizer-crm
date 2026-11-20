-- Payment method aliases, live (Shulim, 2026-11-17). Donary and Sola webhooks and imports bring method names the
-- organization doesn't list ("Credit Card VISA", "usaepay"...), which land on the Task Sheet as "no fee rule".
-- An admin can now map such a name to an existing payment method, under Payment Methods & Fees → Method aliases, or
-- right on the Task Sheet item. Once mapped:
--   * every incoming gift with that name (webhooks, imports, typed in) is saved under the method, so the method's fee
--     rule and bank account apply as for any gift of that method; the name as received is kept in
--     donations.payment_method_received;
--   * gifts already on file with that name are moved to the method. Their fees stay as recorded: remapping never
--     changes a fee or a balance. The original name is kept in payment_method_received.
--
-- The 24 names suggested for the dashboard chart in readiness #57 were never confirmed by an admin, so they stay
-- suggestions (the chart still uses them) until an admin saves one; nothing on file is moved by this migration.
-- Mapping needs the configure_fees permission, the same as editing fees and these names before.

alter table public.payment_method_aliases add column if not exists applied_at timestamptz;
alter table public.payment_method_aliases add column if not exists applied_by text;
alter table public.donations add column if not exists payment_method_received text;

-- The live mapping for a name received: the method's name, or null when there's none (or the name is itself a method).
create or replace function public.mapped_method(p_org uuid, p_method text) returns text
language sql stable security definer set search_path = '' as $$
  select a.method_name from public.payment_method_aliases a
  where a.org_id = p_org and lower(a.alias) = lower(trim(p_method)) and a.applied_at is not null
    and not a.not_a_method and a.method_name is not null
    and not exists (select 1 from public.payment_methods m where m.org_id = p_org and lower(m.name) = lower(trim(p_method)))
$$;
revoke execute on function public.mapped_method(uuid, text) from public, anon, authenticated;

-- Incoming gifts: before the fee and bank account are worked out (donation_defaults), so they follow the method.
create or replace function public.apply_method_alias() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_to text;
begin
  if nullif(trim(new.payment_method), '') is null then return new; end if;
  if tg_op = 'UPDATE' and new.payment_method is not distinct from old.payment_method then return new; end if;
  v_to := public.mapped_method(new.org_id, new.payment_method);
  if v_to is not null and v_to is distinct from new.payment_method then
    new.payment_method_received := coalesce(new.payment_method_received, new.payment_method);
    new.payment_method := v_to;
  end if;
  return new;
end $$;
revoke execute on function public.apply_method_alias() from public, anon, authenticated;
drop trigger if exists ab_method_alias on public.donations;
create trigger ab_method_alias before insert or update of payment_method on public.donations
  for each row execute function public.apply_method_alias();

-- Moving gifts on file to a method keeps their fee: donation_defaults skips its fee recalculation while
-- oizer.keep_fee is on.
do $$
declare v_def text; v_new text;
begin
  select pg_get_functiondef('public.donation_defaults'::regproc) into v_def;
  v_new := replace(v_def, 'and new.gateway_id is null and new.donary_id is null',
                          'and new.gateway_id is null and new.donary_id is null and coalesce(current_setting(''oizer.keep_fee'', true), '''') <> ''on''');
  if v_new = v_def then raise exception 'donation_defaults: fee rule not found'; end if;
  execute v_new;
end $$;

-- Saving a name: check it, mark it live, and move the gifts on file.
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
  -- Saved by a person: live from now on (the #57 suggestions, written by a migration, stay suggestions until then).
  if auth.uid() is not null then
    new.applied_at := now();
    new.applied_by := public.current_email();
  end if;
  return new;
end $$;
revoke execute on function public.method_alias_guard() from public, anon, authenticated;
drop trigger if exists method_alias_guard on public.payment_method_aliases;
create trigger method_alias_guard before insert or update on public.payment_method_aliases
  for each row execute function public.method_alias_guard();

create or replace function public.method_alias_remap() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_n integer;
begin
  if new.applied_at is null or new.not_a_method or new.method_name is null then return null; end if;
  perform set_config('oizer.keep_fee', 'on', true);
  update public.donations d
     set payment_method_received = coalesce(d.payment_method_received, d.payment_method), payment_method = new.method_name
   where d.org_id = new.org_id and lower(trim(d.payment_method)) = lower(new.alias);
  get diagnostics v_n = row_count;
  perform set_config('oizer.keep_fee', '', true);
  if v_n > 0 then
    perform public.write_activity(new.org_id, 'method_alias_applied', 'payment_method_aliases', new.id, null,
      jsonb_build_object('alias', new.alias, 'method', new.method_name, 'gifts_moved', v_n, 'fees', 'kept as recorded'));
  end if;
  return null;
end $$;
revoke execute on function public.method_alias_remap() from public, anon, authenticated;
drop trigger if exists method_alias_remap on public.payment_method_aliases;
create trigger method_alias_remap after insert or update on public.payment_method_aliases
  for each row execute function public.method_alias_remap();

-- The Task Sheet's "Map to existing method": saves the name (or changes its method) and says how many gifts moved.
create or replace function public.map_payment_method(p_alias text, p_method text) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_before integer; v_after integer;
begin
  if not public.has_super_permission('configure_fees') then
    raise exception 'Only an admin who can change fees can map payment methods';
  end if;
  select count(*) into v_before from public.donations d where d.org_id = v_org and lower(trim(d.payment_method)) = lower(trim(p_alias));
  insert into public.payment_method_aliases (org_id, alias, method_name, not_a_method)
  values (v_org, trim(p_alias), p_method, false)
  on conflict (org_id, lower(alias)) do update set method_name = excluded.method_name, not_a_method = false;
  select count(*) into v_after from public.donations d where d.org_id = v_org and lower(trim(d.payment_method)) = lower(trim(p_alias));
  perform public.refresh_no_fee_rule_tasks(v_org);
  return v_before - v_after;
end $$;
revoke execute on function public.map_payment_method(text, text) from public, anon;
grant execute on function public.map_payment_method(text, text) to authenticated;
