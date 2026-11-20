-- Teams and lettered IDs (Moshe Henig, 2026-11-11).
--   * A Team is what was a sub-campaign with a shared balance: it raises into the parent's balance and has no payouts
--     of its own. Sub-campaigns are now only the independent kind. The data is the same (balance_mode 'shared' or
--     'independent'); the screens show them separately.
--   * A new team or sub-campaign gets the parent's ID plus the next letter, in order: 1001A, 1001B, ... 1001Z, 1001AA.
--     Teams and sub-campaigns share the sequence. (A parent whose ID ends in a letter gets a dash: 1001A-A.) Letters
--     are never reused, since IDs are permanent. Existing ones keep their numbers.
--   * Each team can be listed on the parent campaign's payment page, linking to its own page. Off unless turned on.

alter table public.campaigns add column if not exists show_on_parent_page boolean not null default false;

-- 1 -> A, 26 -> Z, 27 -> AA (like spreadsheet columns).
create or replace function public.letter_suffix(p_n integer) returns text
language plpgsql immutable set search_path = '' as $$
declare n integer := p_n; s text := '';
begin
  while n > 0 loop
    s := chr(65 + ((n - 1) % 26)) || s;
    n := (n - 1) / 26;
  end loop;
  return s;
end $$;

create or replace function public.next_child_campaign_id(p_org uuid, p_parent text) returns text
language plpgsql security definer set search_path = '' as $$
declare v_n integer := 1; v_id text; v_sep text := case when p_parent ~ '[A-Za-z]$' then '-' else '' end;
begin
  perform pg_advisory_xact_lock(hashtext('campaign_child:' || p_org::text || ':' || p_parent));
  loop
    v_id := p_parent || v_sep || public.letter_suffix(v_n);
    exit when not exists (select 1 from public.campaigns c where c.org_id = p_org and c.id = v_id);
    v_n := v_n + 1;
  end loop;
  return v_id;
end $$;

create or replace function public.add_sub_campaign(
  p_parent text, p_name text, p_mode text default 'shared', p_goal numeric default null, p_manager text default null
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  p public.campaigns;
  v_base text;
  v_slug text;
  v_n int := 1;
  v_id text;
begin
  select * into p from public.campaigns where org_id = v_org and id = p_parent and deleted_at is null;
  if p.id is null then raise exception 'Campaign not found'; end if;
  if not public.is_admin() and not public.is_primary_on(p_parent) then
    raise exception 'Only an admin or the campaign''s primary fundraiser can add a sub-campaign';
  end if;
  if p.status = 'closed' then raise exception 'Campaign % is closed and can''t accept new activity', p_parent; end if;
  if p_mode not in ('shared','independent') then raise exception 'Choose shared or independent'; end if;
  if nullif(trim(p_name), '') is null then raise exception 'A % needs a name', case when p_mode = 'shared' then 'team' else 'sub-campaign' end; end if;
  if exists (select 1 from public.campaigns c where c.org_id = v_org and c.parent_campaign_id = p_parent and lower(c.internal_name) = lower(trim(p_name)) and c.deleted_at is null) then
    raise exception 'This campaign already has a team or sub-campaign with that name';
  end if;

  v_base := coalesce(nullif(trim(both '-' from regexp_replace(lower(trim(p_name)), '[^a-z0-9]+', '-', 'g')), ''), 'sub');
  v_slug := v_base;
  while exists (select 1 from public.campaigns c where c.org_id = v_org and c.parent_campaign_id = p_parent and c.sub_slug = v_slug and c.deleted_at is null) loop
    v_n := v_n + 1;
    v_slug := v_base || '-' || v_n;
  end loop;

  -- Fees and the bank account follow the parent unless the sub-campaign sets its own.
  insert into public.campaigns (org_id, id, internal_name, parent_campaign_id, balance_mode, sub_slug, goal, manager_id, email, phone, exchange, status)
  values (v_org, public.next_child_campaign_id(v_org, p_parent), trim(p_name), p_parent, p_mode, v_slug, p_goal, p_manager, p.email, p.phone, p.exchange,
          case when p.status = 'draft' then 'draft' else 'active' end)
  returning id into v_id;
  return v_id;
end $$;

-- Show a team on its parent's payment page, or not (admins and the parent's primary fundraiser).
create or replace function public.set_team_on_parent_page(p_campaign text, p_on boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); t public.campaigns;
begin
  select * into t from public.campaigns where org_id = v_org and id = p_campaign and deleted_at is null;
  if t.id is null or t.parent_campaign_id is null then raise exception 'Team not found'; end if;
  if t.balance_mode <> 'shared' then raise exception 'Only teams can be listed on the parent''s payment page'; end if;
  if not public.is_admin() and not public.is_primary_on(t.parent_campaign_id) then
    raise exception 'Only an admin or the parent campaign''s primary fundraiser can change this';
  end if;
  update public.campaigns set show_on_parent_page = coalesce(p_on, false) where org_id = v_org and id = p_campaign;
end $$;

create or replace function public.public_give_page(p_org uuid, p_campaign text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v jsonb := public.give_page_core(p_org, p_campaign); s public.payment_settings; v_site text; o public.organizations;
begin
  if v is null then return null; end if;
  select * into s from public.payment_settings where org_id = p_org;
  select k.turnstile_site_key into v_site from public.integration_keys k where k.org_id = p_org and k.turnstile_secret is not null;
  select * into o from public.organizations where id = p_org;
  v := jsonb_set(v, '{org}', coalesce(v -> 'org', '{}') || jsonb_build_object(
    'email', nullif(trim(o.email), ''),
    'phone', nullif(trim(o.phone), '')));
  -- Teams shown on this page: only those turned on, active, with their own page switched on.
  v := v || jsonb_build_object('teams', coalesce((
    select jsonb_agg(jsonb_build_object('id', t.id, 'name', coalesce(nullif(t.external_name, ''), t.internal_name)) order by t.id)
    from public.campaigns t
    left join public.campaign_page_settings ps on ps.org_id = t.org_id and ps.campaign_id = t.id
    where t.org_id = p_org and t.parent_campaign_id = p_campaign and t.balance_mode = 'shared'
      and t.show_on_parent_page and t.deleted_at is null and t.status = 'active' and coalesce(ps.page_enabled, true)), '[]'::jsonb));
  return jsonb_set(v, '{payments}', (v -> 'payments') || jsonb_build_object(
    'ach', coalesce(s.ach_enabled, false),
    'daf', to_jsonb(coalesce(s.daf_programs, '{}')),
    'ach_authorization', case when s.ach_enabled then public.ach_authorization_text(p_org) end,
    'turnstile_site_key', v_site));
end $$;

revoke execute on function public.next_child_campaign_id(uuid, text) from public, anon, authenticated;
revoke execute on function public.set_team_on_parent_page(text, boolean) from public, anon;
grant execute on function public.set_team_on_parent_page(text, boolean) to authenticated;
