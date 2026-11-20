-- Fundraisers request transfers between their own campaigns (Moshe Henig, 2026-11-15), like campaign, sub-campaign
-- and team requests: the request lands on the Task Sheet ("Transfer Request"), an admin approves or rejects it there,
-- and only an approval makes the transfer (as the admin, so every transfer rule applies). Fundraisers still can't
-- write to transfers. "Their own" means campaigns where they are the primary fundraiser, on both sides.
create table public.transfer_requests (
  org_id            uuid not null default public.current_org_id() references public.organizations(id),
  id                text not null default public.short_id(),
  manager_id        text not null,
  requested_by      text not null default public.current_email(),
  from_campaign_id  text not null,
  to_campaign_id    text not null,
  amount            numeric(12,2) not null check (amount > 0),
  description       text,
  status            text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'withdrawn')),
  admin_note        text,
  decided_by        text,
  decided_at        timestamptz,
  transfer_id       text,
  created_at        timestamptz not null default now(),
  primary key (org_id, id)
);
alter table public.transfer_requests enable row level security;
revoke all on public.transfer_requests from public, anon, authenticated;
grant select on public.transfer_requests to authenticated;
-- Admins see all of their organization's; a fundraiser sees their own. Changes go through the functions below only.
create policy org_wall on public.transfer_requests as restrictive for all to authenticated
  using (org_id = (select public.current_org_id())) with check (org_id = (select public.current_org_id()));
create policy read_own on public.transfer_requests for select to authenticated
  using ((select public.is_admin()) or manager_id = any((select public.my_manager_ids())::text[]));

-- A fundraiser asks: from one of their campaigns to another.
create or replace function public.request_transfer(p_from text, p_to text, p_amount numeric, p_description text default null) returns text
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_mgr text; v_id text; v_bad text;
begin
  if v_org is null or public.my_org_role() is distinct from 'manager' then raise exception 'Only a fundraiser can request a transfer'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'Enter an amount above zero'; end if;
  if p_from is null or p_to is null or p_from = p_to then raise exception 'Choose two different campaigns'; end if;
  select c.manager_id into v_mgr from public.campaigns c
    where c.org_id = v_org and c.id = p_from and c.deleted_at is null and c.manager_id = any(public.my_manager_ids());
  if v_mgr is null or not exists (select 1 from public.campaigns c where c.org_id = v_org and c.id = p_to and c.deleted_at is null and c.manager_id = v_mgr) then
    raise exception 'You can request transfers only between campaigns where you are the primary fundraiser';
  end if;
  select c.id into v_bad from public.campaigns c where c.org_id = v_org and c.id in (p_from, p_to) and (c.status <> 'active' or c.balance_mode = 'shared') limit 1;
  if v_bad is not null then raise exception 'Campaign % can''t take part in a transfer (it isn''t active, or it''s a team without its own balance)', v_bad; end if;
  insert into public.transfer_requests (org_id, manager_id, from_campaign_id, to_campaign_id, amount, description)
  values (v_org, v_mgr, p_from, p_to, round(p_amount, 2), nullif(trim(p_description), '')) returning id into v_id;
  insert into public.task_items (org_id, task_key, task_type, record_id, campaign_id, amount, summary, detail)
  values (v_org, 'transfer_request:' || v_id, 'transfer_request', v_id, p_from, round(p_amount, 2),
          coalesce((select m.full_name from public.managers m where m.org_id = v_org and m.id = v_mgr), 'A fundraiser')
            || ' asks to move ' || public.money_text(round(p_amount, 2)) || ' from ' || p_from || ' to ' || p_to
            || coalesce(': ' || nullif(trim(p_description), ''), ''),
          jsonb_build_object('from', p_from, 'to', p_to));
  return v_id;
end $$;

-- The fundraiser takes it back while it's still waiting.
create or replace function public.withdraw_transfer_request(p_id text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  update public.transfer_requests set status = 'withdrawn', decided_at = now(), decided_by = public.current_email()
  where org_id = v_org and id = p_id and status = 'pending' and manager_id = any(public.my_manager_ids());
  if not found then raise exception 'This request can''t be withdrawn'; end if;
  update public.task_items set resolved_at = now() where org_id = v_org and task_key = 'transfer_request:' || p_id;
end $$;

-- An admin decides. Approving makes the transfer (p_cross confirms one between different bank accounts).
create or replace function public.decide_transfer_request(p_id text, p_approve boolean, p_note text default null, p_cross boolean default false) returns text
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); r public.transfer_requests; v_transfer text;
begin
  perform public.require_admin();
  select * into r from public.transfer_requests where org_id = v_org and id = p_id for update;
  if r.id is null then raise exception 'Request not found'; end if;
  if r.status <> 'pending' then raise exception 'This request was already handled'; end if;
  if p_approve then
    insert into public.transfers (org_id, amount, from_campaign_id, to_campaign_id, description, cross_account)
    values (v_org, r.amount, r.from_campaign_id, r.to_campaign_id,
            coalesce(r.description, 'Requested by ' || r.requested_by), coalesce(p_cross, false))
    returning id into v_transfer;
  end if;
  update public.transfer_requests set status = case when p_approve then 'approved' else 'rejected' end, transfer_id = v_transfer,
    admin_note = nullif(trim(p_note), ''), decided_by = public.current_email(), decided_at = now()
  where org_id = v_org and id = p_id;
  update public.task_items set resolved_at = now() where org_id = v_org and task_key = 'transfer_request:' || p_id;
  return v_transfer;
end $$;

do $$
declare f text;
begin
  foreach f in array array['request_transfer(text, text, numeric, text)', 'withdraw_transfer_request(text)', 'decide_transfer_request(text, boolean, text, boolean)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
