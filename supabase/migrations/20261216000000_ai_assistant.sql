-- AI help assistant (Shulim, 2026-11-11): a chat panel for signed-in staff (admins and fundraisers) that answers
-- how-to questions about Oizer from the app's own guide. Version 1 sees no donor, bank or donation records.
--
-- Per organization (only its admins change these): on/off, model, response length cap and daily questions per
-- person, and optionally the organization's own Anthropic API key. That key is stored encrypted here and is
-- write-only: once saved it is never shown again, only whether one is set. Without one, the assistant Edge
-- Function uses the shared ANTHROPIC_API_KEY Supabase secret. Keys never reach the browser.
--
-- Usage is logged per question (who, when, model, tokens) for the daily limit and the cost summary. The
-- questions and answers themselves are not stored.

create table public.ai_assistant_settings (
  org_id       uuid primary key references public.organizations(id),
  enabled      boolean not null default false,
  model        text not null default 'claude-haiku-5-5' check (model in ('claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5')),
  max_tokens   integer not null default 600 check (max_tokens between 150 and 4000),
  daily_limit  integer not null default 20 check (daily_limit between 1 and 500),
  api_key      bytea,                         -- encrypted with payment_keys_key(); never returned to the app
  key_set_by   text,
  key_set_at   timestamptz,
  updated_by   text default public.current_email(),
  updated_at   timestamptz not null default now()
);
alter table public.ai_assistant_settings enable row level security;
revoke all on public.ai_assistant_settings from public, anon, authenticated;

create table public.ai_assistant_usage (
  id            bigint generated always as identity primary key,
  org_id        uuid not null references public.organizations(id),
  user_id       uuid not null,
  day           date not null,
  at            timestamptz not null default now(),
  model         text not null,
  status        text not null default 'pending' check (status in ('pending', 'answered', 'failed')),
  input_tokens  integer, output_tokens integer, cache_read_tokens integer, cache_write_tokens integer,
  own_key       boolean not null default false
);
create index ai_assistant_usage_user_day on public.ai_assistant_usage (org_id, user_id, day);
alter table public.ai_assistant_usage enable row level security;
revoke all on public.ai_assistant_usage from public, anon, authenticated;

create or replace function public.ai_is_staff() returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_admin() or coalesce(public.my_org_role() = 'manager', false)
$$;

-- Settings for the organization's admins: never the key, only whether one is set.
create or replace function public.ai_settings()
returns table (enabled boolean, model text, max_tokens integer, daily_limit integer, own_key_set boolean, key_set_by text, key_set_at timestamptz, updated_by text, updated_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select coalesce(s.enabled, false), coalesce(s.model, 'claude-haiku-5-5'), coalesce(s.max_tokens, 600), coalesce(s.daily_limit, 20),
         s.api_key is not null, s.key_set_by, s.key_set_at, s.updated_by, s.updated_at
  from (select public.current_org_id() id) o
  left join public.ai_assistant_settings s on s.org_id = o.id
  where public.is_admin()
$$;

create or replace function public.save_ai_settings(p_enabled boolean, p_model text, p_max_tokens integer, p_daily_limit integer) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  perform public.require_admin();
  insert into public.ai_assistant_settings (org_id, enabled, model, max_tokens, daily_limit)
  values (v_org, coalesce(p_enabled, false), coalesce(p_model, 'claude-haiku-5-5'), coalesce(p_max_tokens, 600), coalesce(p_daily_limit, 20))
  on conflict (org_id) do update set enabled = excluded.enabled, model = excluded.model, max_tokens = excluded.max_tokens,
    daily_limit = excluded.daily_limit, updated_by = public.current_email(), updated_at = now();
  perform public.write_activity(v_org, 'ai_assistant_settings_changed', 'ai_assistant_settings', v_org::text, null,
    jsonb_build_object('enabled', p_enabled, 'model', p_model, 'max_tokens', p_max_tokens, 'daily_limit', p_daily_limit));
end $$;

-- Save (or, with an empty value, remove) the organization's own Anthropic key. Write-only.
create or replace function public.set_ai_key(p_key text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_key text := nullif(trim(coalesce(p_key, '')), '');
begin
  perform public.require_admin();
  if v_key is not null and v_key !~ '^sk-ant-[A-Za-z0-9_-]{20,}$' then
    raise exception 'That doesn''t look like an Anthropic API key (they start with sk-ant-)';
  end if;
  insert into public.ai_assistant_settings (org_id) values (v_org) on conflict (org_id) do nothing;
  update public.ai_assistant_settings
  set api_key = case when v_key is null then null else extensions.pgp_sym_encrypt(v_key, public.payment_keys_key()) end,
      key_set_by = case when v_key is null then null else public.current_email() end,
      key_set_at = case when v_key is null then null else now() end
  where org_id = v_org;
  perform public.write_activity(v_org, case when v_key is null then 'ai_key_removed' else 'ai_key_saved' end, 'ai_assistant_settings', v_org::text, null, '{}'::jsonb);
end $$;

-- For the chat panel: is the assistant on for this person, and how many questions are left today?
create or replace function public.ai_available() returns table (enabled boolean, remaining integer, daily_limit integer)
language sql stable security definer set search_path = '' as $$
  select coalesce(s.enabled, false),
         greatest(coalesce(s.daily_limit, 20) - (select count(*) from public.ai_assistant_usage u
            where u.org_id = o.id and u.user_id = auth.uid() and u.day = public.org_today() and u.status <> 'failed'), 0)::int,
         coalesce(s.daily_limit, 20)
  from (select public.current_org_id() id) o
  left join public.ai_assistant_settings s on s.org_id = o.id
  where public.ai_is_staff()
$$;

-- As the person asking: checks they're staff, the assistant is on and today's limit isn't reached, and books
-- the question. Returns what the Edge Function needs, never a key.
create or replace function public.ai_begin_question()
returns table (usage_id bigint, org_id uuid, model text, max_tokens integer, remaining integer)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); s public.ai_assistant_settings; v_used int; v_id bigint;
begin
  if not public.ai_is_staff() then raise exception 'The help assistant is for signed-in staff'; end if;
  select * into s from public.ai_assistant_settings x where x.org_id = v_org;
  if not coalesce(s.enabled, false) then raise exception 'The help assistant is turned off for this organization'; end if;
  perform pg_advisory_xact_lock(hashtext('ai:' || v_org::text || ':' || auth.uid()::text));
  select count(*) into v_used from public.ai_assistant_usage u
  where u.org_id = v_org and u.user_id = auth.uid() and u.day = public.org_today() and u.status <> 'failed';
  if v_used >= s.daily_limit then
    raise exception 'You''ve asked % questions today, the daily limit. It resets tomorrow', s.daily_limit;
  end if;
  insert into public.ai_assistant_usage (org_id, user_id, day, model, own_key)
  values (v_org, auth.uid(), public.org_today(), s.model, s.api_key is not null) returning id into v_id;
  return query select v_id, v_org, s.model, s.max_tokens, s.daily_limit - v_used - 1;
end $$;

-- Service role only (the assistant function).
create or replace function public.ai_org_key(p_org uuid) returns text
language sql stable security definer set search_path = '' as $$
  select extensions.pgp_sym_decrypt(s.api_key, public.payment_keys_key()) from public.ai_assistant_settings s where s.org_id = p_org and s.api_key is not null
$$;

create or replace function public.ai_finish_question(p_usage bigint, p_status text, p_input integer, p_output integer, p_cache_read integer, p_cache_write integer) returns void
language sql security definer set search_path = '' as $$
  update public.ai_assistant_usage set status = p_status, input_tokens = p_input, output_tokens = p_output,
    cache_read_tokens = p_cache_read, cache_write_tokens = p_cache_write
  where id = p_usage and status = 'pending'
$$;

-- Usage for the organization's admins: questions and tokens by model, today and the last 30 days.
create or replace function public.ai_usage_summary()
returns table (period text, model text, questions bigint, input_tokens bigint, output_tokens bigint, cache_read_tokens bigint, cache_write_tokens bigint, own_key_questions bigint)
language sql stable security definer set search_path = '' as $$
  select p.period, u.model, count(*), coalesce(sum(u.input_tokens), 0), coalesce(sum(u.output_tokens), 0),
         coalesce(sum(u.cache_read_tokens), 0), coalesce(sum(u.cache_write_tokens), 0), count(*) filter (where u.own_key)
  from (values ('today', 0), ('30 days', 29)) p(period, back)
  join public.ai_assistant_usage u on u.org_id = public.current_org_id() and u.status = 'answered' and u.day >= public.org_today() - p.back
  where public.is_admin()
  group by p.period, u.model
  order by p.period desc, u.model
$$;

revoke execute on function public.ai_is_staff() from public, anon, authenticated;
do $$
declare f text;
begin
  foreach f in array array['ai_settings()', 'save_ai_settings(boolean, text, integer, integer)', 'set_ai_key(text)', 'ai_available()',
                           'ai_begin_question()', 'ai_usage_summary()'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  foreach f in array array['ai_org_key(uuid)', 'ai_finish_question(bigint, text, integer, integer, integer, integer)'] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
