-- Phase 6, part 4: bulk imports (campaigns, donors, donation history, pledges, fundraisers and campaign contact
-- lists) with a preview, a permanent log and reversal within 24 hours; the source report; and the fundraiser
-- directory. Exports and printed reports are built in the browser from data the caller can already read.
-- The import functions only add or update rows through the usual tables, so balances move only when an import
-- brings in money (donation history or an opening balance), and a reversal takes exactly that back out.

-- ---------------------------------------------------------------------------
-- The import log, and every row each import created or changed
-- ---------------------------------------------------------------------------
create table public.imports (
  id           text not null default public.short_id(),
  org_id       uuid not null default public.current_org_id() references public.organizations(id),
  kind         text not null check (kind in ('campaigns','donors','donations','pledges','fundraisers','contacts')),
  file_name    text,
  campaign_id  text,
  options      jsonb not null default '{}',
  created      integer not null default 0,
  linked       integer not null default 0,
  updated      integer not null default 0,
  skipped      integer not null default 0,
  errors       integer not null default 0,
  imported_by  text default public.current_email(),
  imported_at  timestamptz not null default now(),
  reversed_by  text,
  reversed_at  timestamptz,
  primary key (org_id, id)
);

create table public.import_records (
  org_id     uuid not null references public.organizations(id),
  import_id  text not null,
  seq        integer not null,
  table_name text not null,
  record_id  text not null,
  action     text not null check (action in ('created','updated','linked')),
  old_data   jsonb,
  primary key (org_id, import_id, seq),
  foreign key (org_id, import_id) references public.imports (org_id, id)
);
create index import_records_org_record_idx on public.import_records (org_id, table_name, record_id);

-- A contact list row that matched a donor but disagreed with what's on file. Nothing on file is changed.
create table public.import_conflicts (
  id          text not null default public.short_id(),
  org_id      uuid not null references public.organizations(id),
  import_id   text not null,
  donor_id    text not null,
  matched_by  text not null,
  imported    jsonb not null,
  on_file     jsonb not null,
  resolved_at timestamptz,
  resolved_by text,
  primary key (org_id, id),
  foreign key (org_id, import_id) references public.imports (org_id, id),
  foreign key (org_id, donor_id) references public.donors (org_id, id)
);
create index import_conflicts_org_import_idx on public.import_conflicts (org_id, import_id);
create index import_conflicts_org_donor_idx on public.import_conflicts (org_id, donor_id);

create or replace function public.import_note(p_import text, p_table text, p_record text, p_action text, p_old jsonb default null) returns void
language sql security definer set search_path = '' as $$
  insert into public.import_records (org_id, import_id, seq, table_name, record_id, action, old_data)
  select public.current_org_id(), p_import,
         coalesce((select max(seq) from public.import_records r where r.org_id = public.current_org_id() and r.import_id = p_import), 0) + 1,
         p_table, p_record, p_action, p_old
$$;

-- Cleaning up spreadsheet values.
create or replace function public.import_text(r jsonb, k text) returns text
language sql immutable set search_path = '' as $$ select nullif(trim(r ->> k), '') $$;
create or replace function public.import_digits(p text) returns text
language sql immutable set search_path = '' as $$ select nullif(right(regexp_replace(coalesce(p, ''), '\D', '', 'g'), 10), '') $$;
create or replace function public.import_amount(p text) returns numeric
language plpgsql immutable set search_path = '' as $$
begin
  return round(nullif(regexp_replace(coalesce(p, ''), '[$,\s]', '', 'g'), '')::numeric, 2);
exception when others then return null;
end $$;
create or replace function public.import_date(p text) returns date
language plpgsql immutable set search_path = '' as $$
begin
  if p ~ '^\d{1,2}/\d{1,2}/\d{4}$' then return to_date(p, 'MM/DD/YYYY'); end if;
  return p::date;
exception when others then return null;
end $$;

create or replace function public.import_address(r jsonb) returns text
language sql immutable set search_path = '' as $$
  select nullif(concat_ws(E'\n', public.import_text(r, 'address'),
    nullif(concat_ws(' ', nullif(concat_ws(', ', public.import_text(r, 'city'), public.import_text(r, 'state')), ''), public.import_text(r, 'postal_code')), '')), '')
$$;

-- A donor already on file with this email or phone: the email first.
create or replace function public.import_find_donor(r jsonb, out donor_id text, out matched_by text)
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  if public.import_text(r, 'email') is not null then
    select d.id into donor_id from public.donors d
    where d.org_id = v_org and d.deleted_at is null and d.merged_into is null and lower(d.email) = lower(public.import_text(r, 'email'))
    order by d.created_at limit 1;
    if donor_id is not null then matched_by := 'email'; return; end if;
  end if;
  if public.import_digits(r ->> 'phone') is not null then
    select d.id into donor_id from public.donors d
    where d.org_id = v_org and d.deleted_at is null and d.merged_into is null and public.import_digits(d.phone) = public.import_digits(r ->> 'phone')
    order by d.created_at limit 1;
    if donor_id is not null then matched_by := 'phone'; end if;
  end if;
end $$;

create or replace function public.import_new_donor(p_import text, r jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare v_id text;
begin
  insert into public.donors (org_id, first_name, last_name, email, phone, address, country, notes)
  values (public.current_org_id(), public.import_text(r, 'first_name'), public.import_text(r, 'last_name'), public.import_text(r, 'email'),
          public.import_text(r, 'phone'), public.import_address(r), coalesce(public.import_text(r, 'country'), 'US'), public.import_text(r, 'notes'))
  returning id into v_id;
  perform public.import_note(p_import, 'donors', v_id, 'created');
  return v_id;
end $$;

-- A donor by ID, or by exact name; one not found by name is created. Two with the same name is an error.
create or replace function public.import_donor_ref(p_import text, r jsonb, out donor_id text, out problem text)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  v_name text := public.import_text(r, 'donor_name');
  v_n int;
begin
  if public.import_text(r, 'donor_id') is not null then
    select d.id into donor_id from public.donors d where d.org_id = v_org and d.id = public.import_text(r, 'donor_id') and d.deleted_at is null;
    if donor_id is null then problem := 'No donor with ID ' || public.import_text(r, 'donor_id'); end if;
    return;
  end if;
  if v_name is null then problem := 'Give the donor''s name or ID'; return; end if;
  select count(*), min(d.id) into v_n, donor_id from public.donors d
  where d.org_id = v_org and d.deleted_at is null and d.merged_into is null and lower(d.display_name) = lower(v_name);
  if v_n > 1 then donor_id := null; problem := v_n || ' donors are called ' || v_name || '. Use the donor ID'; return; end if;
  if donor_id is null then
    donor_id := public.import_new_donor(p_import, jsonb_build_object(
      'first_name', split_part(v_name, ' ', 1),
      'last_name', nullif(trim(substr(v_name, length(split_part(v_name, ' ', 1)) + 1)), '')));
  end if;
end $$;

create or replace function public.import_campaign_ref(r jsonb, out campaign_id text, out problem text)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  v_n int;
begin
  if public.import_text(r, 'campaign_id') is not null then
    select c.id into campaign_id from public.campaigns c where c.org_id = v_org and c.id = public.import_text(r, 'campaign_id') and c.deleted_at is null;
    if campaign_id is null then problem := 'No campaign ' || public.import_text(r, 'campaign_id') || '. Import campaigns first'; end if;
    return;
  end if;
  if public.import_text(r, 'campaign_name') is null then problem := 'Give the campaign ID or name'; return; end if;
  select count(*), min(c.id) into v_n, campaign_id from public.campaigns c
  where c.org_id = v_org and c.deleted_at is null
    and lower(public.import_text(r, 'campaign_name')) in (lower(c.internal_name), lower(c.external_name), lower(c.campaign_name));
  if v_n = 0 then problem := 'No campaign called ' || public.import_text(r, 'campaign_name');
  elsif v_n > 1 then campaign_id := null; problem := 'More than one campaign is called ' || public.import_text(r, 'campaign_name') || '. Use the ID';
  end if;
end $$;

create or replace function public.import_result(i int, status text, message text default null, record text default null) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_strip_nulls(jsonb_build_object('row', i, 'status', status, 'message', message, 'record', record))
$$;

-- ---------------------------------------------------------------------------
-- Each kind of import. Rows come as JSON objects with snake_case keys; each returns one result per row.
-- ---------------------------------------------------------------------------
create or replace function public.import_donor_rows(p_import text, p_rows jsonb, p_options jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_out jsonb := '[]';
  r jsonb;
  i int := 0;
  m record;
  v_id text;
  d public.donors;
  v_dup text := coalesce(p_options ->> 'duplicates', 'skip');
begin
  for r in select * from jsonb_array_elements(p_rows) loop
    i := i + 1;
    if public.import_text(r, 'first_name') is null or public.import_text(r, 'last_name') is null then
      v_out := v_out || public.import_result(i, 'error', 'First and last name are required');
      continue;
    end if;
    select * into m from public.import_find_donor(r);
    if m.donor_id is not null and v_dup = 'skip' then
      v_out := v_out || public.import_result(i, 'skipped', 'Already on file, matched by ' || m.matched_by, m.donor_id);
    elsif m.donor_id is not null and v_dup = 'merge' then
      select * into d from public.donors x where x.org_id = public.current_org_id() and x.id = m.donor_id;
      perform public.import_note(p_import, 'donors', d.id, 'updated', to_jsonb(d));
      update public.donors
      set email = coalesce(email, public.import_text(r, 'email')), phone = coalesce(phone, public.import_text(r, 'phone')),
          address = coalesce(address, public.import_address(r)), country = coalesce(country, public.import_text(r, 'country'))
      where org_id = d.org_id and id = d.id;
      v_out := v_out || public.import_result(i, 'updated', 'Matched by ' || m.matched_by || '; empty details filled in', d.id);
    else
      v_id := public.import_new_donor(p_import, r);
      v_out := v_out || public.import_result(i, 'created', case when m.donor_id is not null then 'Created although it matches ' || m.donor_id || ' by ' || m.matched_by end, v_id);
    end if;
  end loop;
  return v_out;
end $$;

create or replace function public.import_contact_rows(p_import text, p_rows jsonb, p_campaign text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  v_out jsonb := '[]';
  r jsonb;
  i int := 0;
  m record;
  d public.donors;
  v_manager text;
  v_id text;
  v_theirs jsonb;
  v_ours jsonb;
begin
  -- Contacts join the list of whoever runs the campaign (or the fundraiser importing them).
  select c.manager_id into v_manager from public.campaigns c where c.org_id = v_org and c.id = p_campaign;
  if not public.is_admin() and not coalesce(v_manager = any(public.my_manager_ids()), false) then v_manager := (public.my_manager_ids())[1]; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    i := i + 1;
    if public.import_text(r, 'first_name') is null and public.import_text(r, 'last_name') is null then
      v_out := v_out || public.import_result(i, 'error', 'Each contact needs a name');
      continue;
    end if;
    select * into m from public.import_find_donor(r);
    if m.donor_id is null then
      v_id := public.import_new_donor(p_import, r);
      v_out := v_out || public.import_result(i, 'created', null, v_id);
    else
      v_id := m.donor_id;
      select * into d from public.donors x where x.org_id = v_org and x.id = v_id;
      v_theirs := jsonb_strip_nulls(jsonb_build_object('name', nullif(trim(concat_ws(' ', public.import_text(r, 'first_name'), public.import_text(r, 'last_name'))), ''),
                  'email', public.import_text(r, 'email'), 'phone', public.import_text(r, 'phone'), 'address', public.import_address(r)));
      v_ours := jsonb_strip_nulls(jsonb_build_object('name', d.display_name, 'email', d.email, 'phone', d.phone, 'address', d.address));
      if exists (select 1 from jsonb_each_text(v_theirs) t
                 where v_ours ->> t.key is not null
                   and case when t.key = 'phone' then public.import_digits(t.value) is distinct from public.import_digits(v_ours ->> t.key)
                            else lower(regexp_replace(t.value, '\s+', ' ', 'g')) <> lower(regexp_replace(v_ours ->> t.key, '\s+', ' ', 'g')) end) then
        insert into public.import_conflicts (org_id, import_id, donor_id, matched_by, imported, on_file)
        values (v_org, p_import, v_id, m.matched_by, v_theirs, v_ours);
      end if;
      v_out := v_out || public.import_result(i, 'linked', 'Matched by ' || m.matched_by, v_id);
    end if;
    if v_manager is not null and not exists (select 1 from public.fundraiser_donors f where f.org_id = v_org and f.manager_id = v_manager and f.donor_id = v_id) then
      insert into public.fundraiser_donors (org_id, manager_id, donor_id) values (v_org, v_manager, v_id);
      perform public.import_note(p_import, 'fundraiser_donors', v_manager || ':' || v_id, 'linked');
    end if;
  end loop;
  return v_out;
end $$;

create or replace function public.import_fundraiser_rows(p_import text, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  v_out jsonb := '[]';
  r jsonb;
  i int := 0;
  v_dup text;
  v_id text;
begin
  for r in select * from jsonb_array_elements(p_rows) loop
    i := i + 1;
    if public.import_text(r, 'first_name') is null or public.import_text(r, 'last_name') is null then
      v_out := v_out || public.import_result(i, 'error', 'First and last name are required');
      continue;
    end if;
    select m.id into v_dup from public.managers m
    where m.org_id = v_org and m.deleted_at is null
      and ((public.import_text(r, 'email') is not null and lower(m.email) = lower(public.import_text(r, 'email')))
           or (public.import_digits(r ->> 'phone') is not null and public.import_digits(m.phone) = public.import_digits(r ->> 'phone')))
    limit 1;
    if v_dup is not null then
      v_out := v_out || public.import_result(i, 'skipped', 'Already a fundraiser with this email or phone', v_dup);
      continue;
    end if;
    insert into public.managers (org_id, first_name, last_name, phone, email)
    values (v_org, public.import_text(r, 'first_name'), public.import_text(r, 'last_name'), public.import_text(r, 'phone'), public.import_text(r, 'email'))
    returning id into v_id;
    perform public.import_note(p_import, 'managers', v_id, 'created');
    v_out := v_out || public.import_result(i, 'created', null, v_id);
  end loop;
  return v_out;
end $$;

create or replace function public.import_campaign_rows(p_import text, p_rows jsonb, p_options jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  v_out jsonb := '[]';
  r jsonb;
  i int := 0;
  c public.campaigns;
  v_id text;
  v_parent text;
  v_manager text;
  v_n int;
  v_status text;
  v_opening numeric;
  v_money text;
  v_overwrite boolean := coalesce(p_options ->> 'duplicates', 'skip') = 'overwrite';
begin
  insert into public.sources (org_id, id, name) values (v_org, 'Imported', 'Imported') on conflict do nothing;
  for r in select * from jsonb_array_elements(p_rows) loop
    i := i + 1;
    v_id := public.import_text(r, 'campaign_id');
    v_parent := public.import_text(r, 'parent_id');
    if public.import_text(r, 'internal_name') is null or public.import_text(r, 'external_name') is null then
      v_out := v_out || public.import_result(i, 'error', 'Internal and external names are required');
      continue;
    end if;
    if v_parent is not null and not exists (select 1 from public.campaigns p where p.org_id = v_org and p.id = v_parent and p.deleted_at is null) then
      v_out := v_out || public.import_result(i, 'error', 'No parent campaign ' || v_parent || '. List parents before their sub-campaigns');
      continue;
    end if;
    if v_id is null and v_parent is not null then
      select v_parent || '-' || chr(65 + count(*)::int) into v_id from public.campaigns k where k.org_id = v_org and k.parent_campaign_id = v_parent;
    end if;
    if v_id is null then
      v_out := v_out || public.import_result(i, 'error', 'Campaign ID is required');
      continue;
    end if;
    v_manager := null;
    if public.import_text(r, 'fundraiser') is not null then
      select count(*), min(m.id) into v_n, v_manager from public.managers m
      where m.org_id = v_org and m.deleted_at is null and (m.id = public.import_text(r, 'fundraiser') or lower(m.full_name) = lower(public.import_text(r, 'fundraiser')));
      if v_n <> 1 then
        v_out := v_out || public.import_result(i, 'error', case when v_n = 0 then 'No fundraiser ' else 'More than one fundraiser called ' end || public.import_text(r, 'fundraiser'));
        continue;
      end if;
    end if;
    v_status := lower(coalesce(public.import_text(r, 'status'), 'active'));
    if v_status not in ('active','archived','draft') then
      v_out := v_out || public.import_result(i, 'error', 'Status has to be Active, Archived or Draft');
      continue;
    end if;
    v_opening := public.import_amount(r ->> 'opening_balance');
    if public.import_text(r, 'opening_balance') is not null and v_opening is null then
      v_out := v_out || public.import_result(i, 'error', 'Opening balance isn''t a number');
      continue;
    end if;
    select * into c from public.campaigns x where x.org_id = v_org and x.id = v_id;
    if c.id is not null and not v_overwrite then
      v_out := v_out || public.import_result(i, 'skipped', 'Campaign ' || v_id || ' already exists', v_id);
      continue;
    end if;
    if c.id is not null then
      perform public.import_note(p_import, 'campaigns', v_id, 'updated', to_jsonb(c));
      update public.campaigns
      set internal_name = public.import_text(r, 'internal_name'), external_name = public.import_text(r, 'external_name'),
          manager_id = coalesce(v_manager, manager_id), goal = coalesce(public.import_amount(r ->> 'goal'), goal),
          status = v_status, notes = coalesce(public.import_text(r, 'notes'), notes)
      where org_id = v_org and id = v_id;
      v_out := v_out || public.import_result(i, 'updated', 'Overwrote the existing campaign', v_id);
    else
      insert into public.campaigns (org_id, id, internal_name, external_name, manager_id, goal, status, notes, parent_campaign_id, balance_mode)
      values (v_org, v_id, public.import_text(r, 'internal_name'), public.import_text(r, 'external_name'), v_manager,
              public.import_amount(r ->> 'goal'), v_status, public.import_text(r, 'notes'), v_parent,
              case when v_parent is not null then 'shared' else 'independent' end);
      perform public.import_note(p_import, 'campaigns', v_id, 'created');
      v_out := v_out || public.import_result(i, 'created', null, v_id);
    end if;
    -- Money from before the system: one labeled entry, no donor and no receipt.
    if coalesce(v_opening, 0) > 0 then
      insert into public.donations (org_id, campaign_id, amount, fee, type, status, source, payment_method, name, notes)
      values (v_org, v_id, v_opening, 0, 'Payment', 'completed', 'Imported', 'Opening Balance', 'Opening Balance (Migrated)', 'Opening Balance (Migrated)')
      returning id into v_money;
      perform public.import_note(p_import, 'donations', v_money, 'created');
    elsif coalesce(v_opening, 0) < 0 then
      insert into public.expenses (org_id, campaign_id, amount, description, memo)
      values (v_org, v_id, -v_opening, 'Opening Balance (Migrated)', 'Opening Balance (Migrated)')
      returning id into v_money;
      perform public.import_note(p_import, 'expenses', v_money, 'created');
    end if;
  end loop;
  return v_out;
end $$;

create or replace function public.import_donation_rows(p_import text, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  v_out jsonb := '[]';
  r jsonb;
  i int := 0;
  dr record;
  cr record;
  v_amount numeric;
  v_date date;
  v_id text;
begin
  insert into public.sources (org_id, id, name) values (v_org, 'Imported', 'Imported') on conflict do nothing;
  for r in select * from jsonb_array_elements(p_rows) loop
    i := i + 1;
    v_amount := public.import_amount(r ->> 'amount');
    v_date := public.import_date(public.import_text(r, 'date'));
    select * into cr from public.import_campaign_ref(r);
    if cr.problem is not null then v_out := v_out || public.import_result(i, 'error', cr.problem); continue; end if;
    if coalesce(v_amount, 0) <= 0 then v_out := v_out || public.import_result(i, 'error', 'Amount has to be more than zero'); continue; end if;
    if v_date is null then v_out := v_out || public.import_result(i, 'error', 'Date is missing or not a date'); continue; end if;
    select * into dr from public.import_donor_ref(p_import, r);
    if dr.problem is not null then v_out := v_out || public.import_result(i, 'error', dr.problem); continue; end if;
    -- History as it was: no fee worked out, and no receipt sent now.
    insert into public.donations (org_id, campaign_id, donor_id, amount, fee, type, status, source, payment_method, notes, created_at)
    values (v_org, cr.campaign_id, dr.donor_id, v_amount, 0, 'Payment', 'completed', 'Imported', public.import_text(r, 'payment_method'),
            nullif(concat_ws(' · ', public.import_text(r, 'notes'),
                   case when lower(coalesce(public.import_text(r, 'receipt_sent'), '')) in ('y','yes','true','1') then 'Receipt sent before import' end), ''),
            (v_date::timestamp + time '12:00') at time zone 'America/New_York')
    returning id into v_id;
    perform public.import_note(p_import, 'donations', v_id, 'created');
    v_out := v_out || public.import_result(i, 'created', null, v_id);
  end loop;
  return v_out;
end $$;

create or replace function public.import_pledge_rows(p_import text, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  v_out jsonb := '[]';
  r jsonb;
  i int := 0;
  dr record;
  cr record;
  v_amount numeric;
  v_date date;
  v_status text;
  v_id text;
begin
  for r in select * from jsonb_array_elements(p_rows) loop
    i := i + 1;
    v_amount := public.import_amount(r ->> 'pledge_amount');
    v_date := public.import_date(public.import_text(r, 'date_pledged'));
    v_status := lower(coalesce(public.import_text(r, 'status'), 'open'));
    select * into cr from public.import_campaign_ref(r);
    if cr.problem is not null then v_out := v_out || public.import_result(i, 'error', cr.problem); continue; end if;
    if coalesce(v_amount, 0) <= 0 then v_out := v_out || public.import_result(i, 'error', 'Pledge amount has to be more than zero'); continue; end if;
    if v_date is null then v_out := v_out || public.import_result(i, 'error', 'Date pledged is missing or not a date'); continue; end if;
    if v_status = 'fulfilled' then
      v_out := v_out || public.import_result(i, 'skipped', 'A fulfilled pledge is already in the donation history');
      continue;
    end if;
    if v_status not in ('open','cancelled') then v_out := v_out || public.import_result(i, 'error', 'Status has to be Open, Fulfilled or Cancelled'); continue; end if;
    select * into dr from public.import_donor_ref(p_import, r);
    if dr.problem is not null then v_out := v_out || public.import_result(i, 'error', dr.problem); continue; end if;
    insert into public.pledges (org_id, campaign_id, donor_id, amount, date_pledged, expected_date, notes, source,
                                cancelled_at, cancel_reason)
    values (v_org, cr.campaign_id, dr.donor_id, v_amount, v_date, public.import_date(public.import_text(r, 'expected_date')),
            public.import_text(r, 'notes'), 'Imported',
            case when v_status = 'cancelled' then now() end, case when v_status = 'cancelled' then 'Cancelled before import' end)
    returning id into v_id;
    perform public.import_note(p_import, 'pledges', v_id, 'created');
    v_out := v_out || public.import_result(i, 'created', null, v_id);
  end loop;
  return v_out;
end $$;

-- Runs an import. With p_commit false it does all the work, reports what would happen, and undoes it.
create or replace function public.run_import(p_kind text, p_file_name text, p_rows jsonb, p_options jsonb default '{}', p_commit boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  v_campaign text := p_options ->> 'campaign';
  v_id text;
  v_rows jsonb;
  v_result jsonb;
begin
  if p_kind = 'contacts' then
    if v_campaign is null or not (public.is_admin() or v_campaign = any(public.my_campaign_ids())) then
      raise exception 'You can import contacts to your own campaigns only';
    end if;
  elsif not public.has_super_permission('run_imports') then
    raise exception 'Only the Super Admin can run this import';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then raise exception 'The file has no rows'; end if;
  if jsonb_array_length(p_rows) > 20000 then raise exception 'Split the file: up to 20,000 rows at a time'; end if;

  begin
    insert into public.imports (org_id, kind, file_name, campaign_id, options)
    values (v_org, p_kind, p_file_name, v_campaign, coalesce(p_options, '{}')) returning id into v_id;
    v_rows := case p_kind
      when 'donors'      then public.import_donor_rows(v_id, p_rows, p_options)
      when 'contacts'    then public.import_contact_rows(v_id, p_rows, v_campaign)
      when 'fundraisers' then public.import_fundraiser_rows(v_id, p_rows)
      when 'campaigns'   then public.import_campaign_rows(v_id, p_rows, p_options)
      when 'donations'   then public.import_donation_rows(v_id, p_rows)
      when 'pledges'     then public.import_pledge_rows(v_id, p_rows)
    end;
    if v_rows is null then raise exception 'Unknown import type %', p_kind; end if;
    update public.imports
    set created = (select count(*) from jsonb_array_elements(v_rows) x where x ->> 'status' = 'created'),
        linked  = (select count(*) from jsonb_array_elements(v_rows) x where x ->> 'status' = 'linked'),
        updated = (select count(*) from jsonb_array_elements(v_rows) x where x ->> 'status' = 'updated'),
        skipped = (select count(*) from jsonb_array_elements(v_rows) x where x ->> 'status' = 'skipped'),
        errors  = (select count(*) from jsonb_array_elements(v_rows) x where x ->> 'status' = 'error')
    where org_id = v_org and id = v_id;
    select jsonb_build_object('import_id', v_id, 'committed', p_commit, 'created', i.created, 'linked', i.linked, 'updated', i.updated,
                              'skipped', i.skipped, 'errors', i.errors, 'rows', v_rows,
                              'conflicts', (select count(*) from public.import_conflicts c where c.org_id = v_org and c.import_id = v_id))
      into v_result
    from public.imports i where i.org_id = v_org and i.id = v_id;
    if not p_commit then raise exception 'preview' using errcode = 'ZP001'; end if;
  exception when sqlstate 'ZP001' then
    return v_result - 'import_id';
  end;
  return v_result;
end $$;

-- Takes an import back out within a day: what it created goes, what it changed goes back.
-- Refused if anything has since been built on what it created.
create or replace function public.reverse_import(p_import text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  im public.imports;
  rec public.import_records;
  v_ids text[];
begin
  if not public.has_super_permission('reverse_imports') then raise exception 'Only the Super Admin can reverse an import'; end if;
  select * into im from public.imports where org_id = v_org and id = p_import for update;
  if im.id is null then raise exception 'Import not found'; end if;
  if im.reversed_at is not null then raise exception 'This import was already reversed'; end if;
  if im.imported_at < now() - interval '24 hours' then raise exception 'An import can be reversed only within 24 hours'; end if;

  select array_agg(record_id) into v_ids from public.import_records where org_id = v_org and import_id = p_import and action = 'created';
  v_ids := coalesce(v_ids, '{}');
  if exists (select 1 from public.donations d join public.import_records r on r.org_id = d.org_id and r.import_id = p_import and r.table_name in ('donors','campaigns') and r.action = 'created'
             where d.org_id = v_org and d.deleted_at is null and not (d.id = any(v_ids))
               and ((r.table_name = 'donors' and d.donor_id = r.record_id) or (r.table_name = 'campaigns' and d.campaign_id = r.record_id))) then
    raise exception 'Donations have since been entered for donors or campaigns from this import, so it can''t be reversed';
  end if;
  if exists (select 1 from public.pledge_payments p join public.import_records r on r.org_id = p.org_id and r.import_id = p_import and r.table_name = 'pledges' and r.action = 'created'
             where p.org_id = v_org and p.pledge_id = r.record_id) then
    raise exception 'Payments have since been matched to pledges from this import, so it can''t be reversed';
  end if;

  for rec in select * from public.import_records where org_id = v_org and import_id = p_import order by seq desc loop
    if rec.action = 'linked' then
      delete from public.fundraiser_donors where org_id = v_org and manager_id = split_part(rec.record_id, ':', 1) and donor_id = split_part(rec.record_id, ':', 2);
    elsif rec.action = 'updated' and rec.table_name = 'donors' then
      update public.donors set email = rec.old_data ->> 'email', phone = rec.old_data ->> 'phone', address = rec.old_data ->> 'address', country = rec.old_data ->> 'country'
      where org_id = v_org and id = rec.record_id;
    elsif rec.action = 'updated' and rec.table_name = 'campaigns' then
      update public.campaigns
      set internal_name = rec.old_data ->> 'internal_name', external_name = rec.old_data ->> 'external_name', manager_id = rec.old_data ->> 'manager_id',
          goal = (rec.old_data ->> 'goal')::numeric, status = rec.old_data ->> 'status', notes = rec.old_data ->> 'notes'
      where org_id = v_org and id = rec.record_id;
    elsif rec.action = 'created' then
      execute format('update public.%I set deleted_at = now(), deleted_by = public.current_email() where org_id = $1 and id = $2 and deleted_at is null', rec.table_name)
        using v_org, rec.record_id;
    end if;
  end loop;
  update public.import_conflicts set resolved_at = now(), resolved_by = public.current_email()
  where org_id = v_org and import_id = p_import and resolved_at is null;
  update public.imports set reversed_at = now(), reversed_by = public.current_email() where org_id = v_org and id = p_import;
end $$;

create or replace function public.resolve_import_conflict(p_conflict text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_admin();
  update public.import_conflicts set resolved_at = now(), resolved_by = public.current_email()
  where org_id = public.current_org_id() and id = p_conflict and resolved_at is null;
end $$;

-- ---------------------------------------------------------------------------
-- Reporting by source: one line per payment with its source tag and category
-- ---------------------------------------------------------------------------
create or replace function public.machine_for_source(p_source text) returns integer
language sql stable security definer set search_path = '' as $$
  select m.nickname from public.machines m where m.org_id = public.current_org_id() and m.source_id = p_source
$$;

create view public.source_lines with (security_invoker = true) as
select d.id, d.org_id, d.created_at, d.campaign_id, d.donor_id,
       case when d.anonymous then 'Anonymous' else coalesce(dn.display_name, d.name) end as donor_name,
       d.amount, coalesce(d.fee, 0) as fee, d.amount - coalesce(d.fee, 0) as net, d.payment_method, d.source,
       case when public.machine_for_source(d.source) is not null then 'Donary — Machine ' || public.machine_for_source(d.source)
            when pm.category = 'DAF' then 'DAF — ' || d.payment_method
            when pm.category = 'Voucher' then 'Manual — ' || d.payment_method
            when d.source = 'Imported' then 'Imported'
            when d.source is null or d.source = 'Manual' then 'Manual — ' || coalesce(d.payment_method, 'Other')
            else coalesce(s.name, d.source) end as source_tag,
       case when public.machine_for_source(d.source) is not null then 'Donary Machines'
            when pm.category = 'DAF' then 'DAF'
            when d.source = 'Imported' then 'Imported'
            when d.source is null or d.source = 'Manual' or pm.category = 'Voucher' then 'Manual'
            when lower(coalesce(s.name, d.source)) like '%phone%' then 'Phone'
            when lower(coalesce(s.name, d.source)) like '%link%' or lower(coalesce(s.name, d.source)) like '%online%' then 'Online'
            else 'Other' end as source_category
from public.donations d
left join public.donors dn on dn.org_id = d.org_id and dn.id = d.donor_id
left join public.sources s on s.org_id = d.org_id and s.id = d.source
left join public.payment_methods pm on pm.org_id = d.org_id and lower(pm.name) = lower(d.payment_method)
where d.deleted_at is null and d.status = 'completed';

-- ---------------------------------------------------------------------------
-- The fundraiser directory, with last sign-in and the role on each campaign
-- ---------------------------------------------------------------------------
create or replace function public.fundraiser_directory()
returns table (id text, full_name text, phone text, email text, status text, last_login timestamptz, campaigns jsonb)
language sql stable security definer set search_path = '' as $$
  select m.id, m.full_name, m.phone, m.email, m.status,
         (select max(u.last_sign_in_at) from public.user_managers um join auth.users u on u.id = um.user_id
          where um.org_id = m.org_id and um.manager_id = m.id),
         coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', coalesce(c.external_name, c.internal_name), 'role',
                                     case when c.manager_id = m.id then 'Primary' else 'Secondary' end) order by c.id)
                   from public.campaigns c where c.org_id = m.org_id and c.deleted_at is null and c.status <> 'closed'
                     and (c.manager_id = m.id or m.id = any(c.sub_manager_ids))), '[]')
  from public.managers m
  where public.is_admin() and m.org_id = public.current_org_id() and m.deleted_at is null
  order by m.full_name
$$;

-- An opening balance never gets a receipt.
create or replace function public.receipt_blocker(d public.donations) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when d.deleted_at is not null then 'This donation was deleted'
    when d.status <> 'completed' then 'Only a completed donation gets a receipt'
    when d.payment_method = 'Opening Balance' then 'An opening balance isn''t a donation and gets no receipt'
    when d.voucher_id is not null or d.type <> 'Payment' then 'Vouchers and DAF grants don''t get a receipt; the DAF sends the donor''s paperwork'
    when exists (select 1 from public.payment_methods m where m.org_id = d.org_id and lower(m.name) = lower(d.payment_method) and not m.receipt_allowed)
      then d.payment_method || ' payments don''t get a receipt; the DAF sends the donor''s paperwork'
    when d.donor_id is null and nullif(trim(d.name), '') is null then 'Add the donor first'
  end
$$;

-- ---------------------------------------------------------------------------
-- The Task Sheet gains contact list conflicts
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
         public.org_midnight(d.reversal_date), 'Check' || coalesce(' #' || d.check_number, '') || coalesce(' from ' || nullif(d.name, ''), '') || coalesce(' · ' || d.reversal_reason, '')
  from public.donations d
  left join public.campaigns c on c.org_id = d.org_id and c.id = d.campaign_id
  left join public.managers m on m.org_id = c.org_id and m.id = c.manager_id
  where d.status = 'returned' and d.reversal_date is not null and d.deleted_at is null
  union all
  select d.org_id, 'post_dated_due:' || d.id, 'post_dated_due', d.id, d.campaign_id, m.full_name, d.amount,
         public.org_midnight(d.check_date), 'Check' || coalesce(' #' || d.check_number, '') || coalesce(' from ' || nullif(d.name, ''), '') || ' is ready to deposit'
  from public.donations d
  left join public.campaigns c on c.org_id = d.org_id and c.id = d.campaign_id
  left join public.managers m on m.org_id = c.org_id and m.id = c.manager_id
  where d.post_dated and d.check_date <= current_date and d.status = 'completed' and d.deleted_at is null
  union all
  select v.org_id, 'voucher_overdue:' || v.id || ':' || coalesce(v.expected_date::text, ''), 'voucher_overdue', v.id, v.campaign_id, m.full_name, v.remaining,
         public.org_midnight(coalesce(v.expected_date, v.date_received + 30)),
         v.id || coalesce(' · issuer #' || v.issuer_number, '') || ' · ' || replace(v.issuer, 'Voucher — ', '') || coalesce(' · ' || v.donor_name, '') || ' · face ' || v.face_value
  from public.voucher_list v
  left join public.campaigns c on c.org_id = v.org_id and c.id = v.campaign_id
  left join public.managers m on m.org_id = c.org_id and m.id = c.manager_id
  where v.overdue
  union all
  select p.org_id, 'pledge_overdue:' || p.id || ':' || coalesce(p.next_due_date, p.expected_date)::text, 'pledge_overdue', p.id, p.campaign_id, m.full_name, p.balance,
         public.org_midnight(coalesce(p.next_due_date, p.expected_date)), p.reference || coalesce(' · ' || p.donor_name, '')
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
    and not exists (select 1 from public.checks k where k.org_id = e.org_id and k.expense_id = e.id and k.status in ('voided','lost'))
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
  union all
  select r.org_id, 'payout_request:' || r.id, 'payout_request', r.id, r.campaign_id, m.full_name, r.amount,
         r.created_at,
         'To ' || r.recipient_name || ' by ' || r.method || case when r.full_balance then ' · full balance' else '' end
           || case when r.source = 'phone' then ' · by phone' else '' end
  from public.payout_requests r
  left join public.managers m on m.org_id = r.org_id and m.id = r.manager_id
  where r.status = 'pending'
  union all
  select e.org_id, 'scheduled_payout:' || e.id, 'scheduled_payout', e.id, e.campaign_id, m.full_name, e.amount,
         public.org_midnight(e.scheduled_for),
         coalesce(e.method, 'Payout') || coalesce(' to ' || nullif(e.payee, ''), '') || ' was set for ' || to_char(e.scheduled_for, 'FMMonth FMDD, YYYY')
  from public.expenses e
  left join public.campaigns c on c.org_id = e.org_id and c.id = e.campaign_id
  left join public.managers m on m.org_id = c.org_id and m.id = c.manager_id
  where e.processed_at is null and e.scheduled_for <= public.org_today() and e.deleted_at is null
  union all
  select o.id, 'receipt_text_missing', 'receipt_text_missing', o.id::text, null, null, null, o.created_at,
         'Set the Hebrew and English receipt text in Settings → Receipt Text. Until then receipts leave those sections out'
  from public.organizations o
  where o.id = public.current_org_id()
    and not exists (select 1 from public.receipt_templates t where t.org_id = o.id and t.level = 'default'
                    and (t.hebrew_text is not null or t.english_text is not null))
  union all
  select r.org_id, 'receipt_reissue:' || r.id, 'receipt_reissue', r.id, r.campaign_id, m.full_name, r.amount, r.voided_at,
         r.receipt_number || ' for ' || coalesce(r.donor_name, 'a donor') || ' was voided because the donation changed'
  from public.receipts r
  left join public.campaigns c on c.org_id = r.org_id and c.id = r.campaign_id
  left join public.managers m on m.org_id = c.org_id and m.id = c.manager_id
  where r.needs_reissue and r.status = 'voided'
    and not exists (select 1 from public.receipts x where x.org_id = r.org_id and x.donation_ids && r.donation_ids and x.status = 'issued')
  union all
  select c.org_id, 'import_conflict:' || c.id, 'import_conflict', c.id, i.campaign_id, null, null, i.imported_at,
         coalesce(c.on_file ->> 'name', 'A donor') || ': the contact list has different details (matched by ' || c.matched_by || ')'
  from public.import_conflicts c
  join public.imports i on i.org_id = c.org_id and i.id = c.import_id
  where c.resolved_at is null and i.reversed_at is null
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
alter table public.imports          enable row level security;
alter table public.import_records   enable row level security;
alter table public.import_conflicts enable row level security;
revoke all on public.imports, public.import_records, public.import_conflicts from anon;
revoke insert, update, delete on public.imports, public.import_records, public.import_conflicts from authenticated;

do $$
declare t text;
begin
  foreach t in array array['imports','import_records','import_conflicts'] loop
    execute format('create policy org_wall on public.%I as restrictive for all to authenticated
                    using (org_id = (select public.current_org_id()))
                    with check (org_id = (select public.current_org_id()))', t);
    execute format('create policy admin_read on public.%I for select to authenticated using ((select public.is_admin()))', t);
  end loop;
end $$;
create trigger log_row_change after insert or update or delete on public.imports for each row execute function public.log_row_change();
create trigger log_row_change after insert or update or delete on public.import_conflicts for each row execute function public.log_row_change();
-- Fundraisers see their own contact list imports.
create policy own_read on public.imports for select to authenticated using (imported_by = (select public.current_email()));

revoke all on public.source_lines from anon;
grant select on public.source_lines to authenticated;

do $$
declare f text;
begin
  foreach f in array array[
    'import_note(text, text, text, text, jsonb)', 'import_find_donor(jsonb)', 'import_new_donor(text, jsonb)',
    'import_donor_ref(text, jsonb)', 'import_campaign_ref(jsonb)',
    'import_donor_rows(text, jsonb, jsonb)', 'import_contact_rows(text, jsonb, text)', 'import_fundraiser_rows(text, jsonb)',
    'import_campaign_rows(text, jsonb, jsonb)', 'import_donation_rows(text, jsonb)', 'import_pledge_rows(text, jsonb)',
    'receipt_blocker(public.donations)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
  foreach f in array array[
    'run_import(text, text, jsonb, jsonb, boolean)', 'reverse_import(text)', 'resolve_import_conflict(text)',
    'machine_for_source(text)', 'fundraiser_directory()'
  ] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
