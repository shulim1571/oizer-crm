-- Two phone-lookup additions (2026-11-10).
--
-- 1. RECENT (Moshe Henig, approved by Shulim): an admin or fundraiser texts RECENT, or RECENT 1001, to the
--    organization's number and gets their latest transactions back.
--    * Who: an active admin or Super Admin whose phone is on their notification settings, or a fundraiser
--      by a registered phone or the phone on their fundraiser record (as for BAL).
--    * What: admins see every campaign; a fundraiser only the campaigns they're primary or secondary on.
--      The last 5 transactions that count or are on their way (completed, to collect, post-dated, waiting
--      for approval): date, amount, campaign number and the donor's initials. No full names, phones or cards.
--    * Limits: 10 RECENT texts per phone per hour, then one "too many" reply and silence for the hour.
--      An unknown phone gets one polite reply a day, then nothing (each reply costs a text).
--    * It answers only while text replies are on, like the rest of the lookup.
-- 2. Leave out Donary (Shulim): an optional setting, off by default, next to the text and phone switches.
--    When on, the automatic text and phone replies (BAL, campaign lookups, the phone line and RECENT) leave
--    Donary donations out of the amounts and the transaction lists they report.

alter table public.phone_lookup_settings add column if not exists exclude_donary boolean not null default false;

alter table public.phone_lookups drop constraint if exists phone_lookups_outcome_check;
alter table public.phone_lookups add constraint phone_lookups_outcome_check
  check (outcome in ('answered','list','wrong_pin','needs_pin','not_found','locked','help','recent','recent_limited','recent_unknown'));

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------
drop function if exists public.phone_lookup_status();
create function public.phone_lookup_status()
returns table (sms_replies boolean, voice boolean, exclude_donary boolean, sms_number text, updated_by text, updated_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select coalesce(s.sms_replies, false), coalesce(s.voice, false), coalesce(s.exclude_donary, false), m.sms_from, s.updated_by, s.updated_at
  from (select public.current_org_id() id) o
  left join public.phone_lookup_settings s on s.org_id = o.id
  left join public.messaging_settings m on m.org_id = o.id
  where public.is_admin()
$$;

drop function if exists public.save_phone_lookup(boolean, boolean);
create function public.save_phone_lookup(p_sms_replies boolean, p_voice boolean, p_exclude_donary boolean default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  perform public.require_org_super_admin('turn phone and text lookup on or off');
  insert into public.phone_lookup_settings (org_id, sms_replies, voice, exclude_donary)
  values (v_org, coalesce(p_sms_replies, false), coalesce(p_voice, false), coalesce(p_exclude_donary, false))
  on conflict (org_id) do update set sms_replies = excluded.sms_replies, voice = excluded.voice,
    exclude_donary = coalesce(p_exclude_donary, public.phone_lookup_settings.exclude_donary),
    updated_by = public.current_email(), updated_at = now();
  perform public.write_activity(v_org, 'phone_lookup_changed', 'phone_lookup_settings', v_org::text, null,
    jsonb_build_object('sms_replies', coalesce(p_sms_replies, false), 'voice', coalesce(p_voice, false), 'exclude_donary', p_exclude_donary));
end $$;

-- ---------------------------------------------------------------------------
-- Leaving Donary out of the figures
-- ---------------------------------------------------------------------------
-- A campaign's Donary donations, counted the way campaign_summary counts donations.
create or replace function public.phone_donary_totals(p_org uuid, p_campaign text)
returns table (raised numeric, fees numeric, pending numeric)
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(case when d.status <> 'completed' then 0 when d.type = 'Payment' then d.amount else coalesce(d.funded, 0) end), 0),
         coalesce(sum(case when d.status in ('completed','collect','refunded','returned') then coalesce(d.fee, 0) else 0 end), 0),
         coalesce(sum(case when d.status in ('completed','collect') then coalesce(d.batch_pending, 0) else 0 end), 0)
  from public.donations d
  where d.org_id = p_org and d.campaign_id = p_campaign and d.deleted_at is null and d.donary_id is not null
$$;

-- What a reply says about a campaign, with or without its Donary donations. Without them, raised and pending
-- lose those gifts, and the balance loses their net (for a shared pool, every member's).
create or replace function public.phone_campaign_json(c public.campaign_summary, p_exclude_donary boolean) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare t record; v_net numeric := 0;
begin
  if not coalesce(p_exclude_donary, false) then return public.phone_campaign_json(c); end if;
  select * into t from public.phone_donary_totals(c.org_id, c.id);
  if c.pool_id is null then
    select coalesce(sum(x.raised - x.fees), 0) into v_net
    from public.campaign_summary s cross join lateral public.phone_donary_totals(s.org_id, s.id) x
    where s.org_id = c.org_id and coalesce(s.pool_id, s.id) = c.id;
  end if;
  return public.phone_campaign_json(c) || jsonb_build_object(
    'raised', coalesce(c.raised, 0) - t.raised,
    'balance', coalesce(c.balance, 0) - v_net,
    'pending', coalesce(c.pending_balance, 0) - t.pending);
end $$;

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
  v_ex boolean := coalesce((select s.exclude_donary from public.phone_lookup_settings s where s.org_id = p_org), false);
begin
  if v_campaign is null then
    if v_manager is null then
      v_res := jsonb_build_object('outcome', 'help');
    else
      select coalesce(jsonb_agg(public.phone_campaign_json(s, v_ex) order by s.id), '[]') into v_list
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
      v_res := jsonb_build_object('outcome', 'answered', 'campaign', public.phone_campaign_json(c, v_ex));
    elsif (select count(*) from public.phone_lookups l where l.org_id = p_org and l.from_phone = v_from
             and l.outcome = 'wrong_pin' and l.at > now() - interval '1 hour') >= 5 then
      v_res := jsonb_build_object('outcome', 'locked');
    elsif nullif(trim(p_pin), '') is null then
      v_res := jsonb_build_object('outcome', 'needs_pin', 'campaign_id', c.id);
    elsif c.pin is not null and c.pin = trim(p_pin) then
      v_res := jsonb_build_object('outcome', 'answered', 'campaign', public.phone_campaign_json(c, v_ex));
    else
      v_res := jsonb_build_object('outcome', 'wrong_pin');
    end if;
  end if;
  v_out := v_res->>'outcome';
  insert into public.phone_lookups (org_id, channel, from_phone, campaign_id, outcome)
  values (p_org, p_channel, v_from, case when v_out = 'not_found' then left(v_campaign, 20) else coalesce(v_res #>> '{campaign,id}', v_res->>'campaign_id') end, v_out);
  return v_res;
end $$;

-- ---------------------------------------------------------------------------
-- RECENT
-- ---------------------------------------------------------------------------
-- "Moshe Klein" -> "M.K."; nothing usable -> "-".
create or replace function public.phone_initials(p_name text) returns text
language sql immutable set search_path = '' as $$
  select coalesce(nullif((select string_agg(upper(left(w, 1)) || '.', '' order by i)
                          from unnest(string_to_array(trim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')), ' ')) with ordinality u(w, i)
                          where i <= 2 and w <> ''), ''), '-')
$$;

create or replace function public.phone_recent(p_org uuid, p_from text, p_campaign text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_from text := public.normalize_phone(p_from);
  v_admin boolean;
  v_manager text;
  v_ex boolean := coalesce((select s.exclude_donary from public.phone_lookup_settings s where s.org_id = p_org), false);
  v_tz text := coalesce((select o.timezone from public.organizations o where o.id = p_org), 'America/New_York');
  v_campaign text := nullif(trim(p_campaign), '');
  v_lines text;
begin
  if v_from is null then return null; end if;
  v_admin := exists (select 1 from public.org_members m
                     join public.notification_preferences p on p.org_id = m.org_id and p.user_id = m.user_id
                     where m.org_id = p_org and m.role in ('super_admin','admin') and m.status = 'active'
                       and public.normalize_phone(p.phone) = v_from);
  v_manager := case when v_admin then null else public.phone_fundraiser(p_org, p_from) end;

  -- Unknown phone: one polite reply a day, then nothing.
  if not v_admin and v_manager is null then
    if exists (select 1 from public.phone_lookups l where l.org_id = p_org and l.from_phone = v_from
               and l.outcome = 'recent_unknown' and l.at > now() - interval '24 hours') then return null; end if;
    insert into public.phone_lookups (org_id, channel, from_phone, outcome) values (p_org, 'sms', v_from, 'recent_unknown');
    return 'This phone isn''t registered for RECENT. Ask the office to add your number.';
  end if;

  -- 10 an hour per phone; past that, one notice and then silence for the hour.
  if (select count(*) from public.phone_lookups l where l.org_id = p_org and l.from_phone = v_from
        and l.outcome = 'recent' and l.at > now() - interval '1 hour') >= 10 then
    if exists (select 1 from public.phone_lookups l where l.org_id = p_org and l.from_phone = v_from
               and l.outcome = 'recent_limited' and l.at > now() - interval '1 hour') then return null; end if;
    insert into public.phone_lookups (org_id, channel, from_phone, outcome) values (p_org, 'sms', v_from, 'recent_limited');
    return 'Too many RECENT texts from this phone. Try again in an hour.';
  end if;

  insert into public.phone_lookups (org_id, channel, from_phone, campaign_id, outcome) values (p_org, 'sms', v_from, left(v_campaign, 20), 'recent');

  if v_campaign is not null and not exists (
       select 1 from public.campaigns c where c.org_id = p_org and c.id = v_campaign and c.deleted_at is null
         and (v_admin or c.manager_id = v_manager or v_manager = any(c.sub_manager_ids))) then
    return format('No campaign %s for this phone.', v_campaign);
  end if;

  select string_agg(line, E'\n' order by at desc) into v_lines from (
    select d.created_at as at,
           to_char(d.created_at at time zone v_tz, 'FMMM/FMDD') || ' ' || public.phone_money(d.amount) || ' #' || d.campaign_id || ' '
             || case when d.anonymous then 'Anon' else public.phone_initials(coalesce(nullif(trim(concat_ws(' ', n.first_name, n.last_name)), ''), d.name)) end
             || case d.status when 'pending' then ' (awaiting approval)' when 'collect' then ' (to collect)' when 'post_dated' then ' (post-dated)' else '' end as line
    from public.donations d
    join public.campaigns c on c.org_id = d.org_id and c.id = d.campaign_id and c.deleted_at is null
    left join public.donors n on n.org_id = d.org_id and n.id = d.donor_id
    where d.org_id = p_org and d.deleted_at is null and d.status in ('completed','collect','post_dated','pending')
      and (v_campaign is null or d.campaign_id = v_campaign)
      and (v_admin or c.manager_id = v_manager or v_manager = any(c.sub_manager_ids))
      and not (v_ex and d.donary_id is not null)
    order by d.created_at desc
    limit 5) x;

  if v_lines is null then
    return case when v_campaign is null then 'No recent transactions.' else format('No recent transactions for #%s.', v_campaign) end;
  end if;
  return case when v_campaign is null then 'Recent:' else format('Recent for #%s:', v_campaign) end || E'\n' || v_lines;
end $$;

create or replace function public.sms_lookup_reply(p_to text, p_from text, p_body text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  o record;
  v_raw text := upper(trim(coalesce(p_body, '')));
  v_body text;
  v_keyword boolean := false;
  v_digits text[];
  v_words text[];
  v_campaign text;
  v_pin text;
  v_pin_bad boolean := false;
  r jsonb;
  v_line text;
  x jsonb;
  v_help text := 'Text a campaign number and its PIN, like: 1001 1234. Fundraisers texting from a registered phone can text BAL, or RECENT for their latest transactions.';
begin
  select * into o from public.phone_org(p_to);
  if o.org_id is null or not o.sms_replies then return null; end if;
  if v_raw in ('STOP','STOPALL','UNSUBSCRIBE','CANCEL','END','QUIT','REVOKE','OPTOUT','START','UNSTOP','YES','HELP','INFO') then return null; end if;

  -- Punctuation out, spaces tidied.
  v_body := trim(regexp_replace(regexp_replace(v_raw, '[^A-Z0-9 ]+', ' ', 'g'), '\s+', ' ', 'g'));
  if v_body in ('MENU', '') and v_raw ~ '^(MENU|\?+)$' then return o.org_name || ': ' || v_help; end if;
  -- RECENT, or RECENT 1001: the sender's latest transactions (phone_recent decides who may see what).
  if v_body ~ '^(RECENT|REC)( \d{1,10})?$' then
    return public.phone_recent(o.org_id, p_from, nullif(trim(regexp_replace(v_body, '^(RECENT|REC)', '')), ''));
  end if;
  if v_body ~ '^(BAL|BALANCE|BALANCES|B)( |$)' then
    v_keyword := true;
    v_body := trim(regexp_replace(v_body, '^(BAL|BALANCE|BALANCES|B)( |$)', ''));
  end if;

  v_digits := array(select m[1] from regexp_matches(v_body, '(\d+)', 'g') m);
  v_words := array(select w from unnest(string_to_array(v_body, ' ')) w where w <> '' and w !~ '^\d+$');

  -- No digits: the keyword alone lists a registered phone's campaigns; anything else isn't for us.
  if cardinality(v_digits) = 0 then
    if not v_keyword then return null; end if;
    r := public.phone_lookup(o.org_id, 'sms', p_from, null, null);
  else
    v_campaign := v_digits[1];
    if cardinality(v_digits) >= 2 then
      v_pin := v_digits[2];
      v_pin_bad := cardinality(v_digits) > 2 or v_pin !~ '^\d{4,8}$';
    elsif not exists (select 1 from public.campaigns c where c.org_id = o.org_id and c.id = v_campaign and c.deleted_at is null) then
      -- "10022468": a real campaign number with the PIN run on.
      select c.id, substr(v_campaign, length(c.id) + 1) into v_campaign, v_pin
      from public.campaigns c
      where c.org_id = o.org_id and c.deleted_at is null and c.id ~ '^\d+$'
        and v_digits[1] like c.id || '%' and length(v_digits[1]) - length(c.id) between 4 and 8
      order by length(c.id) desc limit 1;
      v_campaign := coalesce(v_campaign, v_digits[1]);
    end if;
    -- Letters mixed into the code or PIN ("1002 24x8") make the PIN unreadable.
    if cardinality(v_words) > 0 and v_pin is not null then v_pin_bad := true; end if;
    if length(v_campaign) > 10 then
      return 'No campaign with that number. ' || v_help;
    end if;
    r := public.phone_lookup(o.org_id, 'sms', p_from, v_campaign, case when v_pin_bad then null else v_pin end);
  end if;

  case r->>'outcome'
    when 'answered' then
      x := r->'campaign';
      return format('%s %s: Raised %s, Expenses %s, Balance %s%s.', x->>'id', x->>'name', public.phone_money((x->>'raised')::numeric),
        public.phone_money((x->>'expenses')::numeric), public.phone_money((x->>'balance')::numeric),
        case when (x->>'pending')::numeric <> 0 then ', Pending ' || public.phone_money((x->>'pending')::numeric) else '' end);
    when 'list' then
      if jsonb_array_length(r->'campaigns') = 0 then
        return 'No active campaigns for this phone. To look one up, text its number and PIN, like: 1001 1234';
      end if;
      select string_agg(format('%s %s: %s', e->>'id', e->>'name', public.phone_money((e->>'balance')::numeric)), E'\n') into v_line
      from jsonb_array_elements(r->'campaigns') e;
      return v_line || E'\nText a number for details.';
    when 'needs_pin' then return format('Text %s and its PIN, like: %s 1234', r->>'campaign_id', r->>'campaign_id');
    when 'wrong_pin' then return format('That PIN doesn''t match campaign %s. Check it and text: %s and the PIN', v_campaign, v_campaign);
    when 'locked' then return 'Too many wrong PINs from this phone. Try again in an hour.';
    when 'not_found' then return 'No campaign with that number. ' || v_help;
    else return o.org_name || ': ' || v_help;
  end case;
end $$;

revoke execute on function public.phone_lookup_status() from public, anon;
revoke execute on function public.save_phone_lookup(boolean, boolean, boolean) from public, anon;
grant execute on function public.phone_lookup_status() to authenticated;
grant execute on function public.save_phone_lookup(boolean, boolean, boolean) to authenticated;
revoke execute on function public.phone_donary_totals(uuid, text) from public, anon, authenticated;
revoke execute on function public.phone_campaign_json(public.campaign_summary, boolean) from public, anon, authenticated;
revoke execute on function public.phone_initials(text) from public, anon, authenticated;
revoke execute on function public.phone_recent(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.phone_lookup(uuid, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.sms_lookup_reply(text, text, text) from public, anon, authenticated;
grant execute on function public.phone_lookup(uuid, text, text, text, text) to service_role;
grant execute on function public.sms_lookup_reply(text, text, text) to service_role;
grant execute on function public.phone_recent(uuid, text, text) to service_role;
