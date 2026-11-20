-- Teams on the phone line (Moshe Henig, 2026-11-11). Once a caller has reached a campaign by its ID (a registered
-- fundraiser, or with the right PIN), a caller whose number matches a known donor, fundraiser or admin may hear the
-- campaign's teams as a numbered list and pick one by its number. Other callers aren't offered it.
--
-- Each step of a call is a separate request from Twilio (signature-checked), so the campaign the call has reached
-- is noted against Twilio's call ID; the teams can only be heard on that call, for that campaign, for 30 minutes.

create table if not exists public.phone_call_grants (
  org_id      uuid not null references public.organizations(id),
  call_sid    text not null,
  campaign_id text not null,
  created_at  timestamptz not null default now(),
  primary key (org_id, call_sid, campaign_id)
);
alter table public.phone_call_grants enable row level security;
revoke all on public.phone_call_grants from public, anon, authenticated;

-- A known caller: an admin by their notification phone, a fundraiser by a registered phone, or a donor on file.
create or replace function public.phone_known_caller(p_org uuid, p_from text) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.normalize_phone(p_from) is not null and (
    public.phone_fundraiser(p_org, p_from) is not null
    or exists (select 1 from public.org_members m
               join public.notification_preferences p on p.org_id = m.org_id and p.user_id = m.user_id
               where m.org_id = p_org and m.role in ('super_admin','admin') and m.status = 'active'
                 and public.normalize_phone(p.phone) = public.normalize_phone(p_from))
    or exists (select 1 from public.donors d where d.org_id = p_org and d.deleted_at is null
                 and public.normalize_phone(d.phone) = public.normalize_phone(p_from)))
$$;

-- Notes that this call reached the campaign (called by the phone line after the campaign's numbers were read).
create or replace function public.phone_call_reached(p_org uuid, p_call text, p_campaign text) returns void
language sql security definer set search_path = '' as $$
  insert into public.phone_call_grants (org_id, call_sid, campaign_id) values (p_org, p_call, p_campaign)
  on conflict (org_id, call_sid, campaign_id) do update set created_at = now();
  delete from public.phone_call_grants where created_at < now() - interval '1 day';
$$;

-- The campaign's active teams, numbered 1, 2, 3..., for a known caller on a call that reached the campaign.
-- Empty when the caller isn't known, the call didn't reach the campaign, or it has no teams.
create or replace function public.phone_teams(p_org uuid, p_from text, p_call text, p_campaign text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('n', t.n, 'id', t.id, 'name', t.name, 'raised', t.raised) order by t.n), '[]')
  from (
    select row_number() over (order by c.id) as n, c.id, coalesce(nullif(c.external_name, ''), c.internal_name) as name, coalesce(s.raised, 0) as raised
    from public.campaigns c
    left join public.campaign_summary s on s.org_id = c.org_id and s.id = c.id
    where c.org_id = p_org and c.parent_campaign_id = p_campaign and c.balance_mode = 'shared'
      and c.deleted_at is null and c.status = 'active'
      and public.phone_known_caller(p_org, p_from)
      and exists (select 1 from public.phone_call_grants g where g.org_id = p_org and g.call_sid = p_call
                    and g.campaign_id = p_campaign and g.created_at > now() - interval '30 minutes')
  ) t
$$;

-- The team the caller picked by its number, or null. Logged like other phone lookups.
create or replace function public.phone_pick_team(p_org uuid, p_from text, p_call text, p_campaign text, p_choice int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  select e into v from jsonb_array_elements(public.phone_teams(p_org, p_from, p_call, p_campaign)) e where (e->>'n')::int = p_choice;
  if v is not null then
    insert into public.phone_lookups (org_id, channel, from_phone, campaign_id, outcome, pin_attempt)
    values (p_org, 'voice', public.normalize_phone(p_from), v->>'id', 'answered', false);
  end if;
  return v;
end $$;

revoke execute on function public.phone_known_caller(uuid, text) from public, anon, authenticated;
revoke execute on function public.phone_call_reached(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.phone_teams(uuid, text, text, text) from public, anon, authenticated;
revoke execute on function public.phone_pick_team(uuid, text, text, text, int) from public, anon, authenticated;
grant execute on function public.phone_known_caller(uuid, text), public.phone_call_reached(uuid, text, text),
  public.phone_teams(uuid, text, text, text), public.phone_pick_team(uuid, text, text, text, int) to service_role;
