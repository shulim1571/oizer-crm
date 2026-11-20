-- Phase 5, part 1: campaign requests, team requests, and the Admin Task Sheet. The sheet is worked out
-- from the records themselves, so an item leaves it the moment the thing it points at is dealt with,
-- however that happened. Emails about all of this arrive in Phase 7. No balance changes here.

-- ---------------------------------------------------------------------------
-- Campaign requests: fundraisers ask, admins decide
-- ---------------------------------------------------------------------------
create table public.campaign_requests (
  id                 text not null default public.short_id(),
  org_id             uuid not null default public.current_org_id() references public.organizations(id),
  requested_by       uuid not null default auth.uid(),
  requested_by_email text not null default public.current_email(),
  manager_id         text,
  name               text not null,
  description        text,
  goal               numeric(14,2) check (goal >= 0),
  notes              text,
  parent_campaign_id text,
  status             text not null default 'pending' check (status in ('pending','changes_requested','approved','rejected','withdrawn')),
  admin_note         text,
  decided_by         text,
  decided_at         timestamptz,
  campaign_id        text,
  resubmitted_at     timestamptz,
  created_at         timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, manager_id) references public.managers (org_id, id),
  foreign key (org_id, parent_campaign_id) references public.campaigns (org_id, id) on update cascade,
  foreign key (org_id, campaign_id) references public.campaigns (org_id, id) on update cascade
);
create index campaign_requests_org_status_idx on public.campaign_requests (org_id, status);
create index campaign_requests_org_manager_idx on public.campaign_requests (org_id, manager_id);
create index campaign_requests_org_parent_idx on public.campaign_requests (org_id, parent_campaign_id);
create index campaign_requests_org_campaign_idx on public.campaign_requests (org_id, campaign_id);
create index campaign_requests_requested_by_idx on public.campaign_requests (requested_by);

create or replace function public.submit_campaign_request(
  p_name text, p_description text default null, p_goal numeric default null, p_notes text default null, p_parent text default null
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_managers text[] := public.my_manager_ids();
  v_id text;
begin
  if coalesce(array_length(v_managers, 1), 0) = 0 then
    raise exception 'Only a fundraiser can request a campaign';
  end if;
  if nullif(trim(p_name), '') is null then raise exception 'A request needs a campaign name'; end if;
  if p_parent is not null and not (p_parent = any(public.my_campaign_ids())) then
    raise exception 'You can only request a sub-campaign under your own campaigns';
  end if;
  insert into public.campaign_requests (org_id, manager_id, name, description, goal, notes, parent_campaign_id)
  values (public.current_org_id(), v_managers[1], trim(p_name), nullif(p_description, ''), p_goal, nullif(p_notes, ''), p_parent)
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.withdraw_campaign_request(p_id text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.campaign_requests set status = 'withdrawn'
  where org_id = public.current_org_id() and id = p_id and requested_by = auth.uid() and status in ('pending','changes_requested');
  if not found then raise exception 'This request can no longer be withdrawn'; end if;
end $$;

-- A pending request can't be edited, only withdrawn. Once changes are asked for, it can come back.
create or replace function public.resubmit_campaign_request(
  p_id text, p_name text, p_description text default null, p_goal numeric default null, p_notes text default null
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if nullif(trim(p_name), '') is null then raise exception 'A request needs a campaign name'; end if;
  update public.campaign_requests
  set name = trim(p_name), description = nullif(p_description, ''), goal = p_goal, notes = nullif(p_notes, ''),
      status = 'pending', resubmitted_at = now()
  where org_id = public.current_org_id() and id = p_id and requested_by = auth.uid() and status = 'changes_requested';
  if not found then raise exception 'Only a request sent back for changes can be resubmitted'; end if;
end $$;

-- First admin to act wins, as with payment approvals.
create or replace function public.approve_campaign_request(
  p_id text, p_name text default null, p_goal numeric default null, p_primary text default null,
  p_secondaries text[] default '{}', p_note text default null, p_mode text default 'shared'
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  r public.campaign_requests;
  v_campaign text;
  v_name text;
begin
  perform public.require_admin();
  select * into r from public.campaign_requests where org_id = v_org and id = p_id and status = 'pending' for update;
  if r.id is null then raise exception 'This request was already handled'; end if;
  v_name := coalesce(nullif(trim(p_name), ''), r.name);

  if r.parent_campaign_id is not null then
    v_campaign := public.add_sub_campaign(r.parent_campaign_id, v_name, p_mode, coalesce(p_goal, r.goal), coalesce(p_primary, r.manager_id));
    update public.campaigns set sub_manager_ids = coalesce(p_secondaries, '{}') where org_id = v_org and id = v_campaign;
  else
    insert into public.campaigns (org_id, internal_name, goal, manager_id, sub_manager_ids, notes, status)
    values (v_org, v_name, coalesce(p_goal, r.goal), coalesce(p_primary, r.manager_id), coalesce(p_secondaries, '{}'), r.description, 'active')
    returning id into v_campaign;
  end if;

  update public.campaign_requests
  set status = 'approved', campaign_id = v_campaign, admin_note = nullif(p_note, ''), decided_by = public.current_email(), decided_at = now()
  where org_id = v_org and id = p_id;
  return v_campaign;
end $$;

create or replace function public.decide_campaign_request(p_id text, p_status text, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_admin();
  if p_status not in ('rejected','changes_requested') then raise exception 'Unknown decision'; end if;
  if p_status = 'changes_requested' and nullif(trim(p_note), '') is null then
    raise exception 'Say what needs changing';
  end if;
  update public.campaign_requests
  set status = p_status, admin_note = nullif(p_note, ''), decided_by = public.current_email(), decided_at = now()
  where org_id = public.current_org_id() and id = p_id and status = 'pending';
  if not found then raise exception 'This request was already handled'; end if;
end $$;

-- ---------------------------------------------------------------------------
-- Team requests: a primary fundraiser asks for a secondary or a guest
-- ---------------------------------------------------------------------------
create table public.campaign_team_requests (
  id                 text not null default public.short_id(),
  org_id             uuid not null default public.current_org_id() references public.organizations(id),
  campaign_id        text not null,
  requested_by       uuid not null default auth.uid(),
  requested_by_email text not null default public.current_email(),
  role               text not null check (role in ('secondary','guest')),
  manager_id         text,
  person_name        text,
  email              text,
  phone              text,
  status             text not null default 'pending' check (status in ('pending','approved','rejected')),
  admin_note         text,
  decided_by         text,
  decided_at         timestamptz,
  created_at         timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, campaign_id) references public.campaigns (org_id, id) on update cascade,
  foreign key (org_id, manager_id) references public.managers (org_id, id)
);
create index campaign_team_requests_org_status_idx on public.campaign_team_requests (org_id, status);
create index campaign_team_requests_org_campaign_idx on public.campaign_team_requests (org_id, campaign_id);
create index campaign_team_requests_org_manager_idx on public.campaign_team_requests (org_id, manager_id);
create index campaign_team_requests_requested_by_idx on public.campaign_team_requests (requested_by);

create or replace function public.request_team_member(
  p_campaign text, p_role text, p_name text default null, p_email text default null, p_phone text default null
) returns text
language plpgsql security definer set search_path = '' as $$
declare v_id text;
begin
  if not public.is_admin() and not public.is_primary_on(p_campaign) then
    raise exception 'Only the campaign''s primary fundraiser can request team members';
  end if;
  if p_role not in ('secondary','guest') then raise exception 'Choose secondary or guest'; end if;
  if nullif(trim(p_email), '') is null and nullif(trim(p_phone), '') is null then
    raise exception 'Enter an email or a phone number';
  end if;
  if p_role = 'guest' and nullif(trim(p_email), '') is null then
    raise exception 'A guest signs in by email, so an email is needed';
  end if;
  insert into public.campaign_team_requests (org_id, campaign_id, role, person_name, email, phone)
  values (public.current_org_id(), p_campaign, p_role, nullif(trim(p_name), ''), lower(nullif(trim(p_email), '')), nullif(trim(p_phone), ''))
  returning id into v_id;
  return v_id;
end $$;

-- The admin can change the role before saying yes.
create or replace function public.decide_team_request(p_id text, p_approve boolean, p_role text default null, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  r public.campaign_team_requests;
  v_role text;
  v_manager text;
  v_first text;
  v_last text;
begin
  perform public.require_admin();
  select * into r from public.campaign_team_requests where org_id = v_org and id = p_id and status = 'pending' for update;
  if r.id is null then raise exception 'This request was already handled'; end if;
  v_role := coalesce(p_role, r.role);
  if v_role not in ('secondary','guest') then raise exception 'Choose secondary or guest'; end if;

  if p_approve then
    if v_role = 'guest' then
      if r.email is null then raise exception 'A guest signs in by email, and this request has none'; end if;
      insert into public.campaign_guests (org_id, campaign_id, email) values (v_org, r.campaign_id, r.email) on conflict do nothing;
    else
      select m.id into v_manager from public.managers m
      where m.org_id = v_org and m.deleted_at is null and r.email is not null and lower(m.email) = r.email limit 1;
      if v_manager is null then
        v_first := split_part(coalesce(r.person_name, r.email, r.phone), ' ', 1);
        v_last := nullif(trim(substr(coalesce(r.person_name, ''), length(v_first) + 1)), '');
        insert into public.managers (org_id, first_name, last_name, email, phone)
        values (v_org, v_first, v_last, r.email, r.phone)
        returning id into v_manager;
      end if;
      update public.campaigns c
      set sub_manager_ids = array_append(c.sub_manager_ids, v_manager)
      where c.org_id = v_org and c.id = r.campaign_id
        and not (v_manager = any(c.sub_manager_ids)) and c.manager_id is distinct from v_manager;
    end if;
  end if;

  update public.campaign_team_requests
  set status = case when p_approve then 'approved' else 'rejected' end, role = v_role, manager_id = v_manager,
      admin_note = nullif(p_note, ''), decided_by = public.current_email(), decided_at = now()
  where org_id = v_org and id = p_id;
end $$;

-- ---------------------------------------------------------------------------
-- Unattributed payments reach a campaign here. A pledge can match at that moment too.
-- ---------------------------------------------------------------------------
create or replace function public.assign_unattributed(p_id text, p_campaign text, p_fee numeric default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_admin();
  if p_campaign is null then raise exception 'Choose a campaign'; end if;
  update public.donations
  set campaign_id = p_campaign, fee = coalesce(p_fee, fee), net_donation = amount - coalesce(p_fee, fee, 0)
  where org_id = public.current_org_id() and id = p_id and campaign_id is null and deleted_at is null;
  if not found then raise exception 'This payment was already assigned'; end if;
end $$;

create or replace function public.match_donation_to_pledge() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_pledge text;
begin
  if new.status <> 'completed' or new.type <> 'Payment' or new.deleted_at is not null or new.amount <= 0 then return null; end if;
  if tg_op = 'UPDATE' and old.status = 'completed' and old.campaign_id is not null then return null; end if;
  if exists (select 1 from public.pledge_payments pp where pp.org_id = new.org_id and pp.donation_id = new.id) then return null; end if;

  if new.pledge_id is not null then
    perform public.apply_to_pledge(new.org_id, new.pledge_id, new.id, new.amount, 'pay_button');
    return null;
  end if;
  if new.donor_id is null or new.campaign_id is null then return null; end if;

  select p.id into v_pledge
  from public.pledges p
  cross join lateral (select public.pledge_balance(p.org_id, p.id) as balance) b
  left join lateral (
    select i.amount - coalesce((select sum(pp.amount) from public.pledge_payments pp
                                where pp.org_id = i.org_id and pp.installment_id = i.id), 0) as remaining
    from public.pledge_installments i
    where i.org_id = p.org_id and i.pledge_id = p.id and not i.skipped and not i.cancelled
      and i.amount > coalesce((select sum(pp.amount) from public.pledge_payments pp
                               where pp.org_id = i.org_id and pp.installment_id = i.id), 0)
    order by i.seq limit 1
  ) nxt on p.is_recurring
  where p.org_id = new.org_id and p.donor_id = new.donor_id and p.campaign_id = new.campaign_id
    and p.cancelled_at is null and p.deleted_at is null and b.balance >= new.amount
  order by (case when p.is_recurring then nxt.remaining else b.balance end = new.amount) desc, p.date_pledged, p.created_at
  limit 1;

  if v_pledge is not null then
    perform public.apply_to_pledge(new.org_id, v_pledge, new.id, new.amount, 'auto');
  end if;
  return null;
end $$;

drop trigger match_donation_to_pledge on public.donations;
create trigger match_donation_to_pledge after insert or update of status, campaign_id on public.donations
  for each row execute function public.match_donation_to_pledge();

-- ---------------------------------------------------------------------------
-- The Task Sheet
-- ---------------------------------------------------------------------------
-- Append-only history of what admins did with items. 'dismissed' takes an item off the sheet and
-- 'held' keeps it there, set aside. Keys carry a date where the same thing can come round again.
create table public.task_sheet_actions (
  id         text not null default public.short_id(),
  org_id     uuid not null references public.organizations(id),
  task_key   text not null,
  task_type  text not null,
  summary    text,
  action     text not null,
  note       text,
  acted_by   text not null default public.current_email(),
  created_at timestamptz not null default now(),
  primary key (org_id, id)
);
create index task_sheet_actions_org_key_idx on public.task_sheet_actions (org_id, task_key);
create index task_sheet_actions_org_created_idx on public.task_sheet_actions (org_id, created_at desc);

create or replace function public.log_task_action(p_key text, p_type text, p_summary text, p_action text, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_admin();
  insert into public.task_sheet_actions (org_id, task_key, task_type, summary, action, note)
  values (public.current_org_id(), p_key, p_type, p_summary, p_action, nullif(p_note, ''));
end $$;

-- Deleted records are hidden by policy, but the sheet has to say which account went away.
create or replace function public.removed_accounts()
returns table (org_id uuid, id text, name text, deleted_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select a.org_id, a.id, a.name, a.deleted_at from public.accounts a
  where a.deleted_at is not null and a.org_id = public.current_org_id() and public.is_admin()
$$;

create view public.admin_task_sheet with (security_invoker = true) as
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
         d.reversal_date::timestamptz, 'Check' || coalesce(' #' || d.check_number, '') || coalesce(' from ' || nullif(d.name, ''), '') || coalesce(' · ' || d.reversal_reason, '')
  from public.donations d
  left join public.campaigns c on c.org_id = d.org_id and c.id = d.campaign_id
  left join public.managers m on m.org_id = c.org_id and m.id = c.manager_id
  where d.status = 'returned' and d.reversal_date is not null and d.deleted_at is null
  union all
  select d.org_id, 'post_dated_due:' || d.id, 'post_dated_due', d.id, d.campaign_id, m.full_name, d.amount,
         d.check_date::timestamptz, 'Check' || coalesce(' #' || d.check_number, '') || coalesce(' from ' || nullif(d.name, ''), '') || ' is ready to deposit'
  from public.donations d
  left join public.campaigns c on c.org_id = d.org_id and c.id = d.campaign_id
  left join public.managers m on m.org_id = c.org_id and m.id = c.manager_id
  where d.post_dated and d.check_date <= current_date and d.status = 'completed' and d.deleted_at is null
  union all
  select v.org_id, 'voucher_overdue:' || v.id || ':' || coalesce(v.expected_date::text, ''), 'voucher_overdue', v.id, v.campaign_id, m.full_name, v.remaining,
         coalesce(v.expected_date, v.date_received + 30)::timestamptz,
         v.id || coalesce(' · issuer #' || v.issuer_number, '') || ' · ' || replace(v.issuer, 'Voucher — ', '') || coalesce(' · ' || v.donor_name, '') || ' · face ' || v.face_value
  from public.voucher_list v
  left join public.campaigns c on c.org_id = v.org_id and c.id = v.campaign_id
  left join public.managers m on m.org_id = c.org_id and m.id = c.manager_id
  where v.overdue
  union all
  select p.org_id, 'pledge_overdue:' || p.id || ':' || coalesce(p.next_due_date, p.expected_date)::text, 'pledge_overdue', p.id, p.campaign_id, m.full_name, p.balance,
         coalesce(p.next_due_date, p.expected_date)::timestamptz, p.reference || coalesce(' · ' || p.donor_name, '')
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

revoke all on public.admin_task_sheet from anon;
grant select on public.admin_task_sheet to authenticated;

-- ---------------------------------------------------------------------------
-- Row-level security and function access
-- ---------------------------------------------------------------------------
alter table public.campaign_requests      enable row level security;
alter table public.campaign_team_requests enable row level security;
alter table public.task_sheet_actions     enable row level security;
revoke all on public.campaign_requests, public.campaign_team_requests, public.task_sheet_actions from anon;
-- Everything goes through the functions above.
revoke insert, update, delete on public.campaign_requests, public.campaign_team_requests, public.task_sheet_actions from authenticated;

do $$
declare t text;
begin
  foreach t in array array['campaign_requests','campaign_team_requests','task_sheet_actions'] loop
    execute format('create policy org_wall on public.%I as restrictive for all to authenticated
                    using (org_id = (select public.current_org_id()))
                    with check (org_id = (select public.current_org_id()))', t);
    execute format('create policy admin_read on public.%I for select to authenticated using ((select public.is_admin()))', t);
    execute format('create trigger log_row_change after insert or update on public.%I
                    for each row execute function public.log_row_change()', t);
  end loop;
end $$;
create policy own_read on public.campaign_requests for select to authenticated using (requested_by = (select auth.uid()));
create policy own_read on public.campaign_team_requests for select to authenticated using (requested_by = (select auth.uid()));

do $$
declare f text;
begin
  foreach f in array array[
    'submit_campaign_request(text, text, numeric, text, text)',
    'withdraw_campaign_request(text)',
    'resubmit_campaign_request(text, text, text, numeric, text)',
    'approve_campaign_request(text, text, numeric, text, text[], text, text)',
    'decide_campaign_request(text, text, text)',
    'request_team_member(text, text, text, text, text)',
    'decide_team_request(text, boolean, text, text)',
    'assign_unattributed(text, text, numeric)',
    'log_task_action(text, text, text, text, text)',
    'removed_accounts()'
  ] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
