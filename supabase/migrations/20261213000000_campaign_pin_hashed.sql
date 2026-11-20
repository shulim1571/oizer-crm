-- Campaign PINs, hashed (Moshe Henig, approved by Shulim, 2026-11-10). A fundraiser calling or texting from a
-- phone that isn't registered can still reach his campaign with the campaign's 4-digit PIN.
--   * One PIN per campaign (not per fundraiser). Admins set or change it in the campaign's settings (the
--     Phone PIN field of Edit campaign) or remove it from the campaign's More menu.
--   * Stored only as a bcrypt hash, in campaign_pins, which nobody can read through the app. Anything written
--     to campaigns.pin is hashed on the way in and the column is emptied; existing PINs are hashed here and
--     their plain text cleared. New PINs are exactly 4 digits (older 5-8 digit ones keep working until changed).
--   * Wrong tries: 5 in an hour from one phone lock that phone out, on every campaign; 10 in an hour on one
--     campaign, from any phones, lock that campaign's PIN. Both for the rest of the hour.
--   * Every PIN try is logged in phone_lookups (pin_attempt): result, phone, campaign and time, never the PIN.
--     Admins see them on the Phone & Text Lookup page.
--   * Registered phones (a fundraiser's own campaigns) work as before, without a PIN.

create table public.campaign_pins (
  org_id      uuid not null references public.organizations(id) on delete cascade,
  campaign_id text not null,
  pin_hash    text not null,
  set_by      text default public.current_email(),
  set_at      timestamptz not null default now(),
  primary key (org_id, campaign_id),
  foreign key (org_id, campaign_id) references public.campaigns(org_id, id) on delete cascade
);
alter table public.campaign_pins enable row level security;
revoke all on public.campaign_pins from public, anon, authenticated;

alter table public.phone_lookups add column if not exists pin_attempt boolean not null default false;
alter table public.phone_lookups add column if not exists lock_kind text check (lock_kind in ('caller','campaign'));
create index if not exists phone_lookups_campaign_wrong_pin on public.phone_lookups (org_id, campaign_id, at desc) where outcome = 'wrong_pin';

create or replace function public.pin_caller_limit() returns int language sql immutable as $$ select 5 $$;
create or replace function public.pin_campaign_limit() returns int language sql immutable as $$ select 10 $$;

-- Existing PINs: hashed, then the plain text is gone.
insert into public.campaign_pins (org_id, campaign_id, pin_hash, set_by)
select c.org_id, c.id, extensions.crypt(c.pin, extensions.gen_salt('bf', 8)), 'migration'
from public.campaigns c where c.pin is not null
on conflict (org_id, campaign_id) do nothing;
update public.campaigns set pin = null where pin is not null;

-- A PIN typed into the campaign settings is hashed on the way in; the campaigns row never keeps it.
create or replace function public.campaign_pin_hash() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if nullif(trim(new.pin), '') is not null then
    if trim(new.pin) !~ '^\d{4}$' then raise exception 'The phone PIN is 4 digits'; end if;
    insert into public.campaign_pins (org_id, campaign_id, pin_hash)
    values (new.org_id, new.id, extensions.crypt(trim(new.pin), extensions.gen_salt('bf', 8)))
    on conflict (org_id, campaign_id) do update set pin_hash = excluded.pin_hash, set_by = public.current_email(), set_at = now();
    perform public.write_activity(new.org_id, 'campaign_pin_set', 'campaigns', new.id, new.id, '{}'::jsonb);
  end if;
  new.pin := null;
  return new;
end $$;
-- After insert too, for a new campaign whose PIN row needs the campaign to exist first.
drop trigger if exists campaign_pin_hash on public.campaigns;
create trigger campaign_pin_hash before update on public.campaigns
  for each row when (new.pin is not null) execute function public.campaign_pin_hash();

create or replace function public.campaign_pin_after_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if nullif(trim(new.pin), '') is not null then
    if trim(new.pin) !~ '^\d{4}$' then raise exception 'The phone PIN is 4 digits'; end if;
    insert into public.campaign_pins (org_id, campaign_id, pin_hash)
    values (new.org_id, new.id, extensions.crypt(trim(new.pin), extensions.gen_salt('bf', 8)))
    on conflict (org_id, campaign_id) do update set pin_hash = excluded.pin_hash, set_at = now();
    update public.campaigns set pin = null where org_id = new.org_id and id = new.id;
  end if;
  return null;
end $$;
drop trigger if exists campaign_pin_after_insert on public.campaigns;
create trigger campaign_pin_after_insert after insert on public.campaigns
  for each row when (new.pin is not null) execute function public.campaign_pin_after_insert();

-- Whether a campaign has a PIN, and since when (admins); never the PIN.
create or replace function public.campaign_pin_status(p_campaign text)
returns table (pin_set boolean, set_at timestamptz, set_by text)
language sql stable security definer set search_path = '' as $$
  select k.campaign_id is not null, k.set_at, k.set_by
  from (select 1) one
  left join public.campaign_pins k on k.org_id = public.current_org_id() and k.campaign_id = p_campaign
  where public.is_admin()
$$;

-- Set (4 digits) or remove (null) a campaign's PIN (admins).
create or replace function public.set_campaign_pin(p_campaign text, p_pin text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  perform public.require_admin();
  if not exists (select 1 from public.campaigns c where c.org_id = v_org and c.id = p_campaign and c.deleted_at is null) then
    raise exception 'Campaign not found';
  end if;
  if nullif(trim(p_pin), '') is null then
    delete from public.campaign_pins where org_id = v_org and campaign_id = p_campaign;
    perform public.write_activity(v_org, 'campaign_pin_removed', 'campaigns', p_campaign, p_campaign, '{}'::jsonb);
  else
    update public.campaigns set pin = trim(p_pin) where org_id = v_org and id = p_campaign;
  end if;
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
  v_hash text;
  v_pin_try boolean := false;
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
             and l.outcome = 'wrong_pin' and l.at > now() - interval '1 hour') >= public.pin_caller_limit() then
      -- This phone: too many wrong PINs, on any campaign.
      v_res := jsonb_build_object('outcome', 'locked', 'campaign_id', c.id, 'lock', 'caller');
      v_pin_try := nullif(trim(p_pin), '') is not null;
    elsif (select count(*) from public.phone_lookups l where l.org_id = p_org and l.campaign_id = c.id
             and l.outcome = 'wrong_pin' and l.at > now() - interval '1 hour') >= public.pin_campaign_limit() then
      -- This campaign's PIN: too many wrong tries, from any phones.
      v_res := jsonb_build_object('outcome', 'locked', 'campaign_id', c.id, 'lock', 'campaign');
      v_pin_try := nullif(trim(p_pin), '') is not null;
    elsif nullif(trim(p_pin), '') is null then
      v_res := jsonb_build_object('outcome', 'needs_pin', 'campaign_id', c.id);
    else
      v_pin_try := true;
      select k.pin_hash into v_hash from public.campaign_pins k where k.org_id = p_org and k.campaign_id = c.id;
      if v_hash is not null and extensions.crypt(trim(p_pin), v_hash) = v_hash then
        v_res := jsonb_build_object('outcome', 'answered', 'campaign', public.phone_campaign_json(c, v_ex));
      else
        v_res := jsonb_build_object('outcome', 'wrong_pin', 'campaign_id', c.id);
      end if;
    end if;
  end if;
  v_out := v_res->>'outcome';
  insert into public.phone_lookups (org_id, channel, from_phone, campaign_id, outcome, pin_attempt, lock_kind)
  values (p_org, p_channel, v_from, case when v_out = 'not_found' then left(v_campaign, 20) else coalesce(v_res #>> '{campaign,id}', v_res->>'campaign_id') end,
          v_out, v_pin_try, v_res->>'lock');
  return v_res;
end $$;

-- The lookup log for admins, with whether a PIN was tried and what was locked.
drop function if exists public.recent_phone_lookups();
create function public.recent_phone_lookups()
returns table (at timestamptz, channel text, from_phone text, campaign_id text, outcome text, fundraiser text, pin_attempt boolean, lock_kind text)
language sql stable security definer set search_path = '' as $$
  select l.at, l.channel, l.from_phone, l.campaign_id, l.outcome, m.full_name, l.pin_attempt, l.lock_kind
  from public.phone_lookups l
  left join public.fundraiser_phones f on f.org_id = l.org_id and f.phone = l.from_phone
  left join public.managers m on m.org_id = l.org_id and m.id = coalesce(f.manager_id,
    (select m2.id from public.managers m2 where m2.org_id = l.org_id and public.normalize_phone(m2.phone) = l.from_phone and m2.deleted_at is null limit 1))
  where l.org_id = public.current_org_id() and public.is_admin()
  order by l.at desc limit 200
$$;

revoke execute on function public.campaign_pin_hash() from public, anon, authenticated;
revoke execute on function public.campaign_pin_after_insert() from public, anon, authenticated;
revoke execute on function public.campaign_pin_status(text) from public, anon;
revoke execute on function public.set_campaign_pin(text, text) from public, anon;
revoke execute on function public.recent_phone_lookups() from public, anon;
grant execute on function public.campaign_pin_status(text) to authenticated;
grant execute on function public.set_campaign_pin(text, text) to authenticated;
grant execute on function public.recent_phone_lookups() to authenticated;
revoke execute on function public.phone_lookup(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.phone_lookup(uuid, text, text, text, text) to service_role;
