-- Phase 10, part 1: campaign lookup by text message and by phone (keypad).
--
-- Who may hear a campaign's numbers:
--   * a fundraiser calling or texting from one of their registered phones (their own campaigns, primary or
--     secondary), or from the phone on their fundraiser record;
--   * anyone who gives the campaign number and its PIN (campaigns.pin, set by the office).
-- Five wrong PINs from one phone within an hour locks that phone out for the rest of the hour.
--
-- Replies cost money at Twilio (an outbound text per reply; voice minutes per call), so each organization's
-- Super Admin switches text replies and the phone line on separately; both start off. Texts keep being received
-- and STOP/START keep working either way. Every lookup is logged, never with the PIN.

-- ---------------------------------------------------------------------------
-- Settings and registered phones
-- ---------------------------------------------------------------------------
create table public.phone_lookup_settings (
  org_id      uuid primary key references public.organizations(id) on delete cascade,
  sms_replies boolean not null default false,
  voice       boolean not null default false,
  updated_by  text default public.current_email(),
  updated_at  timestamptz not null default now()
);
alter table public.phone_lookup_settings enable row level security;
revoke all on public.phone_lookup_settings from public, anon, authenticated;

create table public.fundraiser_phones (
  org_id      uuid not null references public.organizations(id) on delete cascade,
  phone       text not null check (phone = public.normalize_phone(phone)),
  manager_id  text not null,
  added_by    text default public.current_email(),
  added_at    timestamptz not null default now(),
  primary key (org_id, phone),
  foreign key (org_id, manager_id) references public.managers(org_id, id) on delete cascade
);
create index on public.fundraiser_phones (org_id, manager_id);
alter table public.fundraiser_phones enable row level security;
revoke all on public.fundraiser_phones from public, anon, authenticated;

create table public.phone_lookups (
  id          bigint generated always as identity primary key,
  org_id      uuid not null references public.organizations(id) on delete cascade,
  channel     text not null check (channel in ('sms','voice')),
  from_phone  text,
  campaign_id text,
  outcome     text not null check (outcome in ('answered','list','wrong_pin','needs_pin','not_found','locked','help')),
  at          timestamptz not null default now()
);
create index on public.phone_lookups (org_id, at desc);
create index on public.phone_lookups (org_id, from_phone, at desc) where outcome = 'wrong_pin';
alter table public.phone_lookups enable row level security;
revoke all on public.phone_lookups from public, anon, authenticated;

-- A PIN is 4 to 8 digits.
alter table public.campaigns add constraint campaigns_pin_digits check (pin is null or pin ~ '^\d{4,8}$');

-- ---------------------------------------------------------------------------
-- Admin
-- ---------------------------------------------------------------------------
create or replace function public.phone_lookup_status()
returns table (sms_replies boolean, voice boolean, sms_number text, updated_by text, updated_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select coalesce(s.sms_replies, false), coalesce(s.voice, false), m.sms_from, s.updated_by, s.updated_at
  from (select public.current_org_id() id) o
  left join public.phone_lookup_settings s on s.org_id = o.id
  left join public.messaging_settings m on m.org_id = o.id
  where public.is_admin()
$$;

create or replace function public.save_phone_lookup(p_sms_replies boolean, p_voice boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  perform public.require_org_super_admin('turn phone and text lookup on or off');
  insert into public.phone_lookup_settings (org_id, sms_replies, voice) values (v_org, coalesce(p_sms_replies, false), coalesce(p_voice, false))
  on conflict (org_id) do update set sms_replies = excluded.sms_replies, voice = excluded.voice,
    updated_by = public.current_email(), updated_at = now();
  perform public.write_activity(v_org, 'phone_lookup_changed', 'phone_lookup_settings', v_org::text, null,
    jsonb_build_object('sms_replies', coalesce(p_sms_replies, false), 'voice', coalesce(p_voice, false)));
end $$;

create or replace function public.fundraiser_phone_list(p_manager text)
returns table (phone text, added_by text, added_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select f.phone, f.added_by, f.added_at from public.fundraiser_phones f
  where f.org_id = public.current_org_id() and f.manager_id = p_manager and public.is_admin()
  order by f.added_at
$$;

create or replace function public.add_fundraiser_phone(p_manager text, p_phone text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  v_phone text := public.normalize_phone(p_phone);
  v_max int := coalesce((select (s.value #>> '{}')::int from public.settings s where s.org_id = v_org and s.key = 'max_phones_per_fundraiser'), 3);
  v_owner text;
begin
  if not public.is_admin() then raise exception 'Only admins can register phones'; end if;
  if v_phone is null then raise exception 'Enter a phone number with its area code'; end if;
  if not exists (select 1 from public.managers m where m.org_id = v_org and m.id = p_manager and m.deleted_at is null) then
    raise exception 'No such fundraiser';
  end if;
  select manager_id into v_owner from public.fundraiser_phones where org_id = v_org and phone = v_phone;
  if v_owner = p_manager then return v_phone; end if;
  if v_owner is not null then raise exception 'That phone is already registered to another fundraiser'; end if;
  if (select count(*) from public.fundraiser_phones where org_id = v_org and manager_id = p_manager) >= v_max then
    raise exception 'A fundraiser can register up to % phones', v_max;
  end if;
  insert into public.fundraiser_phones (org_id, phone, manager_id) values (v_org, v_phone, p_manager);
  perform public.write_activity(v_org, 'fundraiser_phone_added', 'fundraiser_phones', p_manager, null, jsonb_build_object('phone', v_phone));
  return v_phone;
end $$;

create or replace function public.remove_fundraiser_phone(p_manager text, p_phone text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  if not public.is_admin() then raise exception 'Only admins can remove phones'; end if;
  delete from public.fundraiser_phones where org_id = v_org and manager_id = p_manager and phone = public.normalize_phone(p_phone);
  perform public.write_activity(v_org, 'fundraiser_phone_removed', 'fundraiser_phones', p_manager, null, jsonb_build_object('phone', public.normalize_phone(p_phone)));
end $$;

create or replace function public.recent_phone_lookups()
returns table (at timestamptz, channel text, from_phone text, campaign_id text, outcome text, fundraiser text)
language sql stable security definer set search_path = '' as $$
  select l.at, l.channel, l.from_phone, l.campaign_id, l.outcome, m.full_name
  from public.phone_lookups l
  left join public.fundraiser_phones f on f.org_id = l.org_id and f.phone = l.from_phone
  left join public.managers m on m.org_id = l.org_id and m.id = coalesce(f.manager_id,
    (select m2.id from public.managers m2 where m2.org_id = l.org_id and public.normalize_phone(m2.phone) = l.from_phone and m2.deleted_at is null limit 1))
  where l.org_id = public.current_org_id() and public.is_admin()
  order by l.at desc limit 100
$$;

-- ---------------------------------------------------------------------------
-- The lookup itself (service role: the message-events and voice functions)
-- ---------------------------------------------------------------------------
-- The organization a call or text reached, by the number dialled. Null when it has none.
create or replace function public.phone_org(p_to text)
returns table (org_id uuid, org_name text, sms_replies boolean, voice boolean)
language sql stable security definer set search_path = '' as $$
  select o.id, o.name, coalesce(s.sms_replies, false), coalesce(s.voice, false)
  from public.messaging_settings m
  join public.organizations o on o.id = m.org_id and o.status = 'active'
  left join public.phone_lookup_settings s on s.org_id = o.id
  where m.sms_from = public.normalize_phone(p_to)
  limit 1
$$;

-- The fundraiser a phone belongs to in an organization, if any.
create or replace function public.phone_fundraiser(p_org uuid, p_from text) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select f.manager_id from public.fundraiser_phones f where f.org_id = p_org and f.phone = public.normalize_phone(p_from)),
    (select m.id from public.managers m where m.org_id = p_org and m.deleted_at is null and m.status = 'active'
       and public.normalize_phone(m.phone) = public.normalize_phone(p_from) order by m.id limit 1))
$$;

create or replace function public.phone_campaign_json(c public.campaign_summary) returns jsonb
language sql stable as $$
  select jsonb_build_object('id', c.id, 'name', coalesce(nullif(c.external_name, ''), c.internal_name, c.campaign_name, c.id),
    'raised', coalesce(c.raised, 0), 'expenses', coalesce(c.expenses, 0), 'balance', coalesce(c.balance, 0),
    'pending', coalesce(c.pending_balance, 0), 'status', c.status)
$$;

-- One lookup. p_campaign null means "my campaigns" (a registered phone only).
-- Returns {outcome, campaign?, campaigns?}; outcomes as in phone_lookups.
create or replace function public.phone_lookup(p_org uuid, p_channel text, p_from text, p_campaign text, p_pin text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_from text := public.normalize_phone(p_from);
  v_manager text := public.phone_fundraiser(p_org, p_from);
  v_campaign text := nullif(trim(p_campaign), '');
  c public.campaign_summary;
  v_list jsonb;
  v_out text;
  v_res jsonb;
begin
  if v_campaign is null then
    if v_manager is null then
      v_res := jsonb_build_object('outcome', 'help');
    else
      select coalesce(jsonb_agg(public.phone_campaign_json(s) order by s.id), '[]') into v_list
      from (select * from public.campaign_summary x
            where x.org_id = p_org and x.deleted_at is null and x.status = 'active'
              and (x.manager_id = v_manager or v_manager = any(x.sub_manager_ids))
            order by x.id limit 5) s;
      v_res := jsonb_build_object('outcome', 'list', 'campaigns', v_list);
    end if;
  else
    select * into c from public.campaign_summary x where x.org_id = p_org and x.id = v_campaign and x.deleted_at is null;
    if c.id is null then
      v_res := jsonb_build_object('outcome', 'not_found');
    elsif v_manager is not null and (c.manager_id = v_manager or v_manager = any(c.sub_manager_ids)) then
      v_res := jsonb_build_object('outcome', 'answered', 'campaign', public.phone_campaign_json(c));
    elsif (select count(*) from public.phone_lookups l where l.org_id = p_org and l.from_phone = v_from
             and l.outcome = 'wrong_pin' and l.at > now() - interval '1 hour') >= 5 then
      v_res := jsonb_build_object('outcome', 'locked');
    elsif nullif(trim(p_pin), '') is null then
      v_res := jsonb_build_object('outcome', 'needs_pin', 'campaign_id', c.id);
    elsif c.pin is not null and c.pin = trim(p_pin) then
      v_res := jsonb_build_object('outcome', 'answered', 'campaign', public.phone_campaign_json(c));
    else
      v_res := jsonb_build_object('outcome', 'wrong_pin');
    end if;
  end if;
  v_out := v_res->>'outcome';
  insert into public.phone_lookups (org_id, channel, from_phone, campaign_id, outcome)
  values (p_org, p_channel, v_from, case when v_out = 'not_found' then left(v_campaign, 20) else coalesce(v_res #>> '{campaign,id}', v_res->>'campaign_id') end, v_out);
  return v_res;
end $$;

create or replace function public.phone_money(n numeric) returns text
language sql immutable as $$ select '$' || to_char(coalesce(n, 0), 'FM999,999,990.00') $$;

-- The reply to a text, or null for no reply. Recognized messages:
--   BAL / BALANCE / B          a registered phone's campaigns (up to 5)
--   <campaign>                 that campaign, from a registered phone; otherwise asks for the PIN
--   <campaign> <PIN>           that campaign, for anyone with its PIN
--   MENU / ?                   how to use it
-- STOP, START and HELP are Twilio's (its opt-out handling answers them), so they get no reply here.
create or replace function public.sms_lookup_reply(p_to text, p_from text, p_body text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  o record;
  v_body text := upper(regexp_replace(trim(coalesce(p_body, '')), '\s+', ' ', 'g'));
  v_parts text[];
  r jsonb;
  v_line text;
  x jsonb;
  v_help text := 'Text a campaign number and its PIN, like: 1001 1234. Fundraisers texting from a registered phone can text BAL.';
begin
  select * into o from public.phone_org(p_to);
  if o.org_id is null or not o.sms_replies then return null; end if;
  if v_body in ('STOP','STOPALL','UNSUBSCRIBE','CANCEL','END','QUIT','REVOKE','OPTOUT','START','UNSTOP','YES','HELP','INFO') then return null; end if;
  if v_body in ('MENU', '?') then return o.org_name || ': ' || v_help; end if;
  if v_body in ('BAL', 'BALANCE', 'B') then
    r := public.phone_lookup(o.org_id, 'sms', p_from, null, null);
  elsif v_body ~ '^\d{1,10}( \d{4,8})?$' then
    v_parts := string_to_array(v_body, ' ');
    r := public.phone_lookup(o.org_id, 'sms', p_from, v_parts[1], v_parts[2]);
  else
    return null;  -- Not for us: no reply, no cost.
  end if;

  case r->>'outcome'
    when 'answered' then
      x := r->'campaign';
      return format('%s %s: Raised %s, Expenses %s, Balance %s%s.', x->>'id', x->>'name', public.phone_money((x->>'raised')::numeric),
        public.phone_money((x->>'expenses')::numeric), public.phone_money((x->>'balance')::numeric),
        case when (x->>'pending')::numeric <> 0 then ', Pending ' || public.phone_money((x->>'pending')::numeric) else '' end);
    when 'list' then
      if jsonb_array_length(r->'campaigns') = 0 then return 'No active campaigns for this phone.'; end if;
      select string_agg(format('%s %s: %s', e->>'id', e->>'name', public.phone_money((e->>'balance')::numeric)), E'\n') into v_line
      from jsonb_array_elements(r->'campaigns') e;
      return v_line || E'\nText a number for details.';
    when 'needs_pin' then return format('Text %s and its PIN, like: %s 1234', r->>'campaign_id', r->>'campaign_id');
    when 'wrong_pin' then return 'That PIN doesn''t match. Check it and try again.';
    when 'locked' then return 'Too many wrong PINs from this phone. Try again in an hour.';
    when 'not_found' then return 'No campaign with that number.';
    else return o.org_name || ': ' || v_help;
  end case;
end $$;

-- With an organization's own Twilio keys: only its own number.
create or replace function public.sms_lookup_reply_scoped(p_scope uuid, p_to text, p_from text, p_body text) returns text
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.messaging_settings where org_id = p_scope and sms_from = public.normalize_phone(p_to)) then return null; end if;
  return public.sms_lookup_reply(p_to, p_from, p_body);
end $$;

-- ---------------------------------------------------------------------------
-- Who may call what
-- ---------------------------------------------------------------------------
revoke execute on function public.phone_org(text) from public, anon, authenticated;
revoke execute on function public.phone_fundraiser(uuid, text) from public, anon, authenticated;
revoke execute on function public.phone_lookup(uuid, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.sms_lookup_reply(text, text, text) from public, anon, authenticated;
revoke execute on function public.sms_lookup_reply_scoped(uuid, text, text, text) from public, anon, authenticated;
revoke execute on function public.phone_campaign_json(public.campaign_summary) from public, anon, authenticated;
grant execute on function public.phone_org(text) to service_role;
grant execute on function public.phone_lookup(uuid, text, text, text, text) to service_role;
grant execute on function public.sms_lookup_reply(text, text, text) to service_role;
grant execute on function public.sms_lookup_reply_scoped(uuid, text, text, text) to service_role;

revoke execute on function public.phone_lookup_status() from public, anon;
revoke execute on function public.save_phone_lookup(boolean, boolean) from public, anon;
revoke execute on function public.fundraiser_phone_list(text) from public, anon;
revoke execute on function public.add_fundraiser_phone(text, text) from public, anon;
revoke execute on function public.remove_fundraiser_phone(text, text) from public, anon;
revoke execute on function public.recent_phone_lookups() from public, anon;
