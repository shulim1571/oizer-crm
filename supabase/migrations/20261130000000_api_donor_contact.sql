-- Donors' email, phone and address are their own permission on an API key (Shulim, 2026-11-09): a key that reads
-- donors gets names only, unless it was also given donor_contact. Keys made before this keep names only.

alter table public.api_keys drop constraint api_keys_scopes_check;
alter table public.api_keys add constraint api_keys_scopes_check
  check (scopes <@ array['campaigns','donors','donor_contact','donations'] and cardinality(scopes) > 0
         and (not 'donor_contact' = any(scopes) or 'donors' = any(scopes)));

-- Returns the whole key, once. It looks like oz_live_<8 characters>_<48 characters>.
create or replace function public.create_api_key(p_name text, p_scopes text[]) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  v_prefix text := encode(extensions.gen_random_bytes(4), 'hex');
  v_key text := 'oz_live_' || v_prefix || '_' || encode(extensions.gen_random_bytes(24), 'hex');
  v_scopes text[] := (select coalesce(array_agg(distinct s order by s), '{}') from unnest(p_scopes) s);
  v_id uuid;
begin
  perform public.require_org_super_admin('create API keys');
  if nullif(trim(p_name), '') is null then raise exception 'Give the key a name, such as the system that will use it'; end if;
  if cardinality(v_scopes) = 0 then raise exception 'Choose what the key may read'; end if;
  if not v_scopes <@ array['campaigns','donors','donor_contact','donations'] then raise exception 'A key can read campaigns, donors and donations'; end if;
  if 'donor_contact' = any(v_scopes) and not 'donors' = any(v_scopes) then raise exception 'Donor contact details go with reading donors'; end if;
  insert into public.api_keys (org_id, name, prefix, key_hash, scopes)
  values (v_org, trim(p_name), v_prefix, extensions.digest(v_key, 'sha256'), v_scopes)
  returning id into v_id;
  perform public.write_activity(v_org, 'api_key_created', 'api_keys', v_id::text, null,
    jsonb_build_object('name', trim(p_name), 'prefix', v_prefix, 'scopes', v_scopes));
  return v_key;
end $$;

create or replace function public.api_request(p_key text, p_resource text, p_params jsonb default '{}')
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  k public.api_keys;
  v_window timestamptz := date_trunc('minute', now());
  v_count int;
  v_limit int;
  v_after text := nullif(p_params->>'after', '');
  v_id text := nullif(p_params->>'id', '');
  v_since timestamptz;
  v_rows jsonb;
  v_next text;
begin
  -- Who is asking
  if p_key !~ '^oz_live_[0-9a-f]{8}_[0-9a-f]{48}$' then
    raise exception 'Send an API key as: Authorization: Bearer oz_live_…' using errcode = 'PT401';
  end if;
  select * into k from public.api_keys
  where prefix = substr(p_key, 9, 8) and key_hash = extensions.digest(p_key, 'sha256') and revoked_at is null;
  if k.id is null or not exists (select 1 from public.organizations o where o.id = k.org_id and o.status = 'active') then
    raise exception 'That API key isn''t valid, or was revoked' using errcode = 'PT401';
  end if;

  -- How often
  insert into public.api_rate as r (key_id, window_start, requests) values (k.id, v_window, 1)
  on conflict (key_id) do update
    set requests = case when r.window_start = excluded.window_start then r.requests + 1 else 1 end,
        window_start = excluded.window_start
  returning requests into v_count;
  if v_count > public.api_rate_limit() then
    raise exception 'Too many requests: % a minute per key. Try again in % seconds.', public.api_rate_limit(),
      ceil(extract(epoch from v_window + interval '1 minute' - now()))::int using errcode = 'PT429';
  end if;
  if k.last_used_at is null or k.last_used_at < now() - interval '1 minute' then
    update public.api_keys set last_used_at = now() where id = k.id;
  end if;

  -- What
  if p_resource not in ('campaigns','donors','donations') then
    raise exception 'Unknown resource %. Use campaigns, donors or donations.', p_resource using errcode = 'PT404';
  end if;
  if not p_resource = any(k.scopes) then
    raise exception 'This key may not read %', p_resource using errcode = 'PT403';
  end if;
  begin
    v_limit := coalesce((p_params->>'limit')::int, 50);
    v_since := (p_params->>'updated_since')::timestamptz;
  exception when others then
    raise exception 'limit is a number and updated_since a date and time such as 2026-11-01T00:00:00Z' using errcode = 'PT422';
  end;
  if v_limit not between 1 and 100 then raise exception 'limit is between 1 and 100' using errcode = 'PT422'; end if;
  if v_id is not null then v_limit := 1; end if;

  if p_resource = 'campaigns' then
    select coalesce(jsonb_agg(x order by x->>'id' collate "C"), '[]') into v_rows from (
      select jsonb_build_object(
        'id', c.id, 'name', coalesce(c.campaign_name, c.internal_name), 'external_name', c.external_name,
        'internal_name', c.internal_name, 'status', c.status, 'goal', c.goal, 'parent_campaign_id', c.parent_campaign_id,
        'manager_id', c.manager_id, 'featured', c.featured, 'archived_at', c.archived_at, 'closed_at', c.closed_at,
        'created_at', c.created_at, 'updated_at', c.updated_at) x
      from public.campaigns c
      where c.org_id = k.org_id and c.deleted_at is null
        and (v_id is null or c.id = v_id)
        and (v_after is null or c.id collate "C" > v_after)
        and (v_since is null or c.updated_at >= v_since)
      order by c.id collate "C" limit v_limit + 1) s;
  elsif p_resource = 'donors' then
    select coalesce(jsonb_agg(x order by x->>'id' collate "C"), '[]') into v_rows from (
      select jsonb_build_object(
        'id', d.id, 'display_name', d.display_name, 'title', d.english_title, 'first_name', d.first_name,
        'last_name', d.last_name, 'yiddish_name', d.yiddish_name, 'country', d.country, 'merged_into', d.merged_into,
        'created_at', d.created_at, 'updated_at', d.updated_at)
        -- Contact details only for a key that was given them as well.
        || case when 'donor_contact' = any(k.scopes)
                then jsonb_build_object('email', d.email, 'phone', d.phone, 'address', d.address) else '{}'::jsonb end x
      from public.donors d
      where d.org_id = k.org_id and d.deleted_at is null
        and (v_id is null or d.id = v_id)
        and (v_after is null or d.id collate "C" > v_after)
        and (v_since is null or d.updated_at >= v_since)
      order by d.id collate "C" limit v_limit + 1) s;
  else
    select coalesce(jsonb_agg(x order by x->>'id' collate "C"), '[]') into v_rows from (
      select jsonb_build_object(
        'id', n.id, 'campaign_id', n.campaign_id, 'donor_id', n.donor_id, 'status', n.status, 'type', n.type,
        'amount', n.amount, 'fee', n.fee, 'net', n.net_donation, 'payment_method', n.payment_method,
        'source', n.source, 'check_number', n.check_number, 'check_date', n.check_date, 'anonymous', n.anonymous,
        'pledge_id', n.pledge_id, 'created_at', n.created_at, 'updated_at', n.updated_at) x
      from public.donations n
      where n.org_id = k.org_id and n.deleted_at is null
        and (v_id is null or n.id = v_id)
        and (v_after is null or n.id collate "C" > v_after)
        and (v_since is null or n.updated_at >= v_since)
        and (p_params->>'campaign_id' is null or n.campaign_id = p_params->>'campaign_id')
        and (p_params->>'donor_id' is null or n.donor_id = p_params->>'donor_id')
      order by n.id collate "C" limit v_limit + 1) s;
  end if;

  if v_id is not null then
    if jsonb_array_length(v_rows) = 0 then
      raise exception 'No % with id %', rtrim(p_resource, 's'), v_id using errcode = 'PT404';
    end if;
    return jsonb_build_object('data', v_rows->0, 'rate', jsonb_build_object('limit', public.api_rate_limit(),
      'remaining', public.api_rate_limit() - v_count, 'reset', ceil(extract(epoch from v_window + interval '1 minute' - now()))::int));
  end if;
  if jsonb_array_length(v_rows) > v_limit then
    v_rows := v_rows - v_limit;
    v_next := v_rows->(v_limit - 1)->>'id';
  end if;
  return jsonb_build_object('data', v_rows, 'next', v_next,
    'rate', jsonb_build_object('limit', public.api_rate_limit(), 'remaining', public.api_rate_limit() - v_count,
      'reset', ceil(extract(epoch from v_window + interval '1 minute' - now()))::int));
end $$;

revoke execute on function public.api_request(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.api_request(text, text, jsonb) to service_role;
revoke execute on function public.create_api_key(text, text[]) from public, anon;
