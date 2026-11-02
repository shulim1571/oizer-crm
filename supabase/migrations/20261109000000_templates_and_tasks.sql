-- Phase 5, part 2: campaign templates, private fundraiser tasks and call lists. Page settings are kept
-- in a table beside campaigns, ready for the payment pages in Phase 8. No balance changes here.

-- ---------------------------------------------------------------------------
-- Campaign templates
-- ---------------------------------------------------------------------------
create table public.campaign_templates (
  id                 text not null default public.short_id(),
  org_id             uuid not null default public.current_org_id() references public.organizations(id),
  name               text not null,
  description        text,
  is_default         boolean not null default false,
  language           text not null default 'en' check (language in ('en','he','yi')),
  preset_amounts     numeric(12,2)[] not null default '{}',
  allow_other_amount boolean not null default true,
  cover_fee_default  boolean not null default false,
  min_donation       numeric(12,2) check (min_donation >= 0),
  auto_receipt       boolean not null default false,
  receipt_email      boolean not null default true,
  receipt_sms        boolean not null default false,
  donor_wall         boolean not null default false,
  logo_url           text,
  brand_color        text,
  custom_fields      jsonb not null default '[]',
  account_id         text,
  fee_overrides      jsonb not null default '[]',
  created_by         text default public.current_email(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz,
  deleted_by         text,
  primary key (org_id, id),
  foreign key (org_id, account_id) references public.accounts (org_id, id)
);
create index campaign_templates_org_account_idx on public.campaign_templates (org_id, account_id);
create unique index campaign_templates_name on public.campaign_templates (org_id, lower(name)) where deleted_at is null;
create unique index campaign_templates_one_default on public.campaign_templates (org_id) where is_default and deleted_at is null;

-- Taken from the template when a campaign is made. Editing the template later doesn't reach here.
create table public.campaign_page_settings (
  org_id             uuid not null references public.organizations(id),
  campaign_id        text not null,
  template_id        text,
  language           text not null default 'en' check (language in ('en','he','yi')),
  preset_amounts     numeric(12,2)[] not null default '{}',
  allow_other_amount boolean not null default true,
  cover_fee_default  boolean not null default false,
  min_donation       numeric(12,2) check (min_donation >= 0),
  auto_receipt       boolean not null default false,
  receipt_email      boolean not null default true,
  receipt_sms        boolean not null default false,
  donor_wall         boolean not null default false,
  logo_url           text,
  brand_color        text,
  custom_fields      jsonb not null default '[]',
  updated_by         text default public.current_email(),
  updated_at         timestamptz not null default now(),
  primary key (org_id, campaign_id),
  foreign key (org_id, campaign_id) references public.campaigns (org_id, id) on update cascade,
  foreign key (org_id, template_id) references public.campaign_templates (org_id, id)
);
create index campaign_page_settings_org_template_idx on public.campaign_page_settings (org_id, template_id);

create or replace function public.template_rules() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.deleted_at is not null and old.deleted_at is null and new.is_default then
    raise exception 'This is the default template. Choose another default before deleting it';
  end if;
  return new;
end $$;
create trigger template_rules before update on public.campaign_templates
  for each row execute function public.template_rules();

create or replace function public.set_default_template(p_template text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  perform public.require_admin();
  update public.campaign_templates set is_default = false where org_id = v_org and is_default;
  if p_template is not null then
    update public.campaign_templates set is_default = true where org_id = v_org and id = p_template and deleted_at is null;
    if not found then raise exception 'Template not found'; end if;
  end if;
end $$;

-- Saves a campaign's page settings. With a template, its fee overrides and bank account come too,
-- without replacing anything the campaign already set for itself.
create or replace function public.save_campaign_settings(p_campaign text, p_settings jsonb, p_template text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  s public.campaign_page_settings;
  t public.campaign_templates;
begin
  if not public.is_admin() and not public.is_primary_on(p_campaign) and not (
       p_template is not null and exists (
         select 1 from public.campaigns c where c.org_id = v_org and c.id = p_campaign and public.is_primary_on(c.parent_campaign_id))) then
    raise exception 'Only an admin or the campaign''s primary fundraiser can change these settings';
  end if;
  if not exists (select 1 from public.campaigns c where c.org_id = v_org and c.id = p_campaign and c.deleted_at is null) then
    raise exception 'Campaign not found';
  end if;
  if p_template is not null then
    select * into t from public.campaign_templates x where x.org_id = v_org and x.id = p_template and x.deleted_at is null;
    if t.id is null then raise exception 'Template not found'; end if;
  end if;

  s := jsonb_populate_record(null::public.campaign_page_settings, coalesce(p_settings, to_jsonb(t)));
  insert into public.campaign_page_settings (org_id, campaign_id, template_id, language, preset_amounts, allow_other_amount, cover_fee_default,
                                             min_donation, auto_receipt, receipt_email, receipt_sms, donor_wall, logo_url, brand_color, custom_fields)
  values (v_org, p_campaign, p_template, coalesce(s.language, 'en'), coalesce(s.preset_amounts, '{}'), coalesce(s.allow_other_amount, true), coalesce(s.cover_fee_default, false),
          s.min_donation, coalesce(s.auto_receipt, false), coalesce(s.receipt_email, true), coalesce(s.receipt_sms, false), coalesce(s.donor_wall, false),
          nullif(s.logo_url, ''), nullif(s.brand_color, ''), coalesce(s.custom_fields, '[]'))
  on conflict (org_id, campaign_id) do update set
    template_id = coalesce(excluded.template_id, public.campaign_page_settings.template_id), language = excluded.language,
    preset_amounts = excluded.preset_amounts, allow_other_amount = excluded.allow_other_amount, cover_fee_default = excluded.cover_fee_default,
    min_donation = excluded.min_donation, auto_receipt = excluded.auto_receipt, receipt_email = excluded.receipt_email, receipt_sms = excluded.receipt_sms,
    donor_wall = excluded.donor_wall, logo_url = excluded.logo_url, brand_color = excluded.brand_color, custom_fields = excluded.custom_fields,
    updated_by = public.current_email(), updated_at = now();

  if t.id is not null then
    update public.campaigns c set account_id = t.account_id
    where c.org_id = v_org and c.id = p_campaign and c.account_id is null and t.account_id is not null;
    insert into public.campaign_fee_overrides (org_id, campaign_id, method_id, fee_type, fee_percent, fee_flat)
    select v_org, p_campaign, f ->> 'method_id', f ->> 'fee_type', coalesce((f ->> 'fee_percent')::numeric, 0), coalesce((f ->> 'fee_flat')::numeric, 0)
    from jsonb_array_elements(t.fee_overrides) f
    where exists (select 1 from public.payment_methods m where m.org_id = v_org and m.id = f ->> 'method_id')
    on conflict do nothing;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Tasks: a fundraiser's own are private. Ones with no owner stay shared on the campaign, as the
-- system's returned-check follow-ups and existing tasks do.
-- ---------------------------------------------------------------------------
alter table public.tasks
  add column owner_manager_id text,
  add column is_call_list boolean not null default false,
  add constraint tasks_owner_fkey foreign key (org_id, owner_manager_id) references public.managers (org_id, id);
create index tasks_org_owner_idx on public.tasks (org_id, owner_manager_id);

drop policy manager_read on public.tasks;
drop policy manager_insert on public.tasks;
drop policy manager_update on public.tasks;

create policy manager_read on public.tasks for select to authenticated
  using (owner_manager_id = any((select public.my_manager_ids())::text[])
         or (owner_manager_id is null and campaign_id = any((select public.my_campaign_ids())::text[])));
create policy manager_insert on public.tasks for insert to authenticated
  with check ((select public.my_org_role()) = 'manager'
              and (campaign_id is null or campaign_id = any((select public.my_campaign_ids())::text[])));
create policy manager_update on public.tasks for update to authenticated
  using (owner_manager_id = any((select public.my_manager_ids())::text[])
         or (owner_manager_id is null and campaign_id = any((select public.my_campaign_ids())::text[])))
  with check (owner_manager_id = any((select public.my_manager_ids())::text[])
              or (owner_manager_id is null and campaign_id = any((select public.my_campaign_ids())::text[])));
create policy manager_delete on public.tasks for delete to authenticated
  using (owner_manager_id = any((select public.my_manager_ids())::text[]));

-- A fundraiser's new task is their own. An admin can make one on their behalf.
create or replace function public.task_defaults() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    new.owner_manager_id := (public.my_manager_ids())[1];
  end if;
  return new;
end $$;
create trigger task_defaults before insert on public.tasks
  for each row execute function public.task_defaults();

drop trigger guard_deleted_columns on public.tasks;

create or replace function public.task_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_mine boolean := old.owner_manager_id = any(public.my_manager_ids());
begin
  if auth.uid() is null then return new; end if;
  if public.is_admin() then
    -- Admins see personal tasks but don't change them, apart from ones they made themselves.
    if old.owner_manager_id is not null and not coalesce(v_mine, false)
       and old.created_by is distinct from public.current_email()
       and not (old.deleted_at is not null and new.deleted_at is null) then
      raise exception 'This is a fundraiser''s personal task. Admins can see it but not change it';
    end if;
    return new;
  end if;
  if new.deleted_at is distinct from old.deleted_at or new.deleted_by is distinct from old.deleted_by then
    if not coalesce(v_mine, false) then raise exception 'Only admins can delete or restore records'; end if;
  end if;
  if new.owner_manager_id is distinct from old.owner_manager_id then
    raise exception 'A task can''t be moved to someone else';
  end if;
  return new;
end $$;
create trigger task_guard before update on public.tasks
  for each row execute function public.task_guard();

-- ---------------------------------------------------------------------------
-- Call lists: a task with a list of donors, each checked off as contacted
-- ---------------------------------------------------------------------------
create table public.task_call_items (
  id           text not null default public.short_id(),
  org_id       uuid not null references public.organizations(id),
  task_id      text not null,
  donor_id     text not null,
  contacted    boolean not null default false,
  note         text,
  contacted_at timestamptz,
  contacted_by text,
  primary key (org_id, id),
  unique (org_id, task_id, donor_id),
  foreign key (org_id, task_id) references public.tasks (org_id, id) on delete cascade,
  foreign key (org_id, donor_id) references public.donors (org_id, id)
);
create index task_call_items_org_donor_idx on public.task_call_items (org_id, donor_id);

-- Donors reachable by the caller: anyone for an admin, otherwise donors they can already see.
create or replace function public.create_call_list(
  p_title text, p_donors text[], p_campaign text default null, p_due date default null, p_notes text default null, p_owner text default null
) returns text
language plpgsql set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  v_id text;
  v_seen int;
begin
  if nullif(trim(p_title), '') is null then raise exception 'A call list needs a name'; end if;
  if coalesce(array_length(p_donors, 1), 0) = 0 then raise exception 'Choose at least one donor'; end if;
  select count(*) into v_seen from public.donors d where d.id = any(p_donors);
  if v_seen <> (select count(distinct x) from unnest(p_donors) x) then
    raise exception 'One of those donors isn''t available to you';
  end if;
  -- Under the caller's own rights, so the task rules above apply.
  insert into public.tasks (org_id, title, campaign_id, due_date, notes, owner_manager_id, is_call_list, status)
  values (v_org, trim(p_title), p_campaign, p_due, nullif(p_notes, ''), p_owner, true, 'Pending')
  returning id into v_id;
  perform public.add_call_items(v_id, p_donors);
  return v_id;
end $$;

create or replace function public.add_call_items(p_task text, p_donors text[]) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  if not public.is_admin() and not exists (
    select 1 from public.tasks t where t.org_id = v_org and t.id = p_task and t.is_call_list and t.owner_manager_id = any(public.my_manager_ids())) then
    raise exception 'That call list isn''t yours';
  end if;
  insert into public.task_call_items (org_id, task_id, donor_id)
  select v_org, p_task, x from unnest(p_donors) x
  on conflict do nothing;
end $$;

create or replace function public.set_call_item(p_item text, p_contacted boolean, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  i public.task_call_items;
  t public.tasks;
begin
  select * into i from public.task_call_items where org_id = v_org and id = p_item;
  if i.id is null then raise exception 'Not found'; end if;
  select * into t from public.tasks where org_id = v_org and id = i.task_id and deleted_at is null;
  if t.id is null or not coalesce(t.owner_manager_id = any(public.my_manager_ids()), false) then
    if not (public.is_admin() and (t.owner_manager_id is null or t.created_by = public.current_email())) then
      raise exception 'This call list belongs to someone else';
    end if;
  end if;
  update public.task_call_items
  set contacted = p_contacted, note = nullif(p_note, ''),
      contacted_at = case when p_contacted then coalesce(contacted_at, now()) end,
      contacted_by = case when p_contacted then coalesce(contacted_by, public.current_email()) end
  where org_id = v_org and id = p_item;
end $$;

-- ---------------------------------------------------------------------------
-- Row-level security and function access
-- ---------------------------------------------------------------------------
alter table public.campaign_templates     enable row level security;
alter table public.campaign_page_settings enable row level security;
alter table public.task_call_items        enable row level security;
revoke all on public.campaign_templates, public.campaign_page_settings, public.task_call_items from anon;
revoke insert, update, delete on public.campaign_page_settings, public.task_call_items from authenticated;

do $$
declare t text;
begin
  foreach t in array array['campaign_templates','campaign_page_settings','task_call_items'] loop
    execute format('create policy org_wall on public.%I as restrictive for all to authenticated
                    using (org_id = (select public.current_org_id()))
                    with check (org_id = (select public.current_org_id()))', t);
    execute format('create trigger log_row_change after insert or update or delete on public.%I
                    for each row execute function public.log_row_change()', t);
  end loop;
end $$;

create policy hide_deleted on public.campaign_templates as restrictive for select to authenticated using (deleted_at is null);
create policy admin_all on public.campaign_templates for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy active_read on public.campaign_templates for select to authenticated using ((select public.is_active_user()));
create trigger soft_delete before delete on public.campaign_templates for each row execute function public.soft_delete();
create trigger guard_deleted_columns before update on public.campaign_templates for each row execute function public.guard_deleted_columns();
create trigger touch_updated_at before update on public.campaign_templates for each row execute function public.touch_updated_at();

create policy admin_read on public.campaign_page_settings for select to authenticated using ((select public.is_admin()));
create policy manager_read on public.campaign_page_settings for select to authenticated
  using (campaign_id = any((select public.my_campaign_ids())::text[]));

create policy admin_read on public.task_call_items for select to authenticated using ((select public.is_admin()));
create policy manager_read on public.task_call_items for select to authenticated
  using (task_id in (select t.id from public.tasks t));

create or replace function public.restore_record(p_table text, p_id text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_count int;
begin
  if not public.is_admin() then
    raise exception 'Only admins can restore records';
  end if;
  if p_table <> all (array['managers','collectors','donors','accounts','sources','campaigns','donations',
                           'expenses','transfers','pledges','tasks','vouchers','campaign_templates']) then
    raise exception 'Cannot restore records in %', p_table;
  end if;
  execute format('update public.%I set deleted_at = null, deleted_by = null
                  where org_id = $1 and id = $2 and deleted_at is not null', p_table)
    using public.current_org_id(), p_id;
  get diagnostics v_count = row_count;
  return v_count > 0;
end $$;

revoke execute on function public.template_rules() from public, anon, authenticated;
revoke execute on function public.task_defaults() from public, anon, authenticated;
revoke execute on function public.task_guard() from public, anon, authenticated;
do $$
declare f text;
begin
  foreach f in array array[
    'set_default_template(text)',
    'save_campaign_settings(text, jsonb, text)',
    'create_call_list(text, text[], text, date, text, text)',
    'add_call_items(text, text[])',
    'set_call_item(text, boolean, text)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
