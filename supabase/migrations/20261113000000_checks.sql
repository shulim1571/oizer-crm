-- Phase 6, part 2: printed checks. Per-account check settings, a numbered check for a payout, the check register
-- with outstanding, cleared, voided and lost, and the files a check needs (signature image, MICR font).
-- Matching cleared checks to the bank feed is Phase 11. No balance changes here.

-- Midnight where the organization is, so a date-only item doesn't show as the evening before.
create or replace function public.org_midnight(p_date date) returns timestamptz
language sql stable set search_path = '' as $$
  select (p_date::timestamp at time zone coalesce(
    (select s.value #>> '{}' from public.settings s where s.org_id = public.current_org_id() and s.key = 'timezone'),
    'America/New_York'))
$$;

-- ---------------------------------------------------------------------------
-- What prints on each account's checks. Admin only: the numbers are on every check, but not for everyone.
-- ---------------------------------------------------------------------------
create table public.account_check_settings (
  org_id            uuid not null default public.current_org_id() references public.organizations(id),
  account_id        text not null,
  print_name        text,
  print_address     text,
  bank_name         text,
  routing_number    text check (routing_number ~ '^\d{9}$'),
  account_number    text check (account_number ~ '^\d{4,17}$'),
  next_check_number integer check (next_check_number > 0),
  offset_x          numeric(5,2) not null default 0,
  offset_y          numeric(5,2) not null default 0,
  updated_by        text default public.current_email(),
  updated_at        timestamptz not null default now(),
  primary key (org_id, account_id),
  foreign key (org_id, account_id) references public.accounts (org_id, id) on update cascade
);

-- The signature image per account, and the organization's MICR font. Kept in the database, admin only.
create table public.check_assets (
  org_id     uuid not null default public.current_org_id() references public.organizations(id),
  kind       text not null check (kind in ('signature','micr_font')),
  account_id text not null default '',
  file_name  text,
  mime       text not null,
  content    bytea not null,
  -- Which characters of the font are the transit and on-us symbols. Most MICR fonts use A and C.
  transit_char text,
  onus_char    text,
  updated_by text default public.current_email(),
  updated_at timestamptz not null default now(),
  primary key (org_id, kind, account_id)
);

create or replace function public.save_check_settings(
  p_account text, p_print_name text, p_print_address text, p_bank_name text, p_routing text, p_account_number text,
  p_next_number integer, p_offset_x numeric default 0, p_offset_y numeric default 0
) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  perform public.require_admin();
  if not exists (select 1 from public.accounts a where a.org_id = v_org and a.id = p_account and a.deleted_at is null) then
    raise exception 'Account not found';
  end if;
  if nullif(regexp_replace(coalesce(p_routing, ''), '\D', '', 'g'), '') is not null
     and length(regexp_replace(p_routing, '\D', '', 'g')) <> 9 then
    raise exception 'A routing number has 9 digits';
  end if;
  if p_next_number is not null and exists (
    select 1 from public.checks k where k.org_id = v_org and k.account_id = p_account and k.check_number >= p_next_number) then
    raise exception 'Check numbers up to % have already been used on this account', (select max(k.check_number) from public.checks k where k.org_id = v_org and k.account_id = p_account);
  end if;
  insert into public.account_check_settings (org_id, account_id, print_name, print_address, bank_name, routing_number, account_number,
                                             next_check_number, offset_x, offset_y)
  values (v_org, p_account, nullif(trim(p_print_name), ''), nullif(trim(p_print_address), ''), nullif(trim(p_bank_name), ''),
          nullif(regexp_replace(coalesce(p_routing, ''), '\D', '', 'g'), ''), nullif(regexp_replace(coalesce(p_account_number, ''), '\D', '', 'g'), ''),
          p_next_number, coalesce(p_offset_x, 0), coalesce(p_offset_y, 0))
  on conflict (org_id, account_id) do update
  set print_name = excluded.print_name, print_address = excluded.print_address, bank_name = excluded.bank_name,
      routing_number = excluded.routing_number, account_number = excluded.account_number, next_check_number = excluded.next_check_number,
      offset_x = excluded.offset_x, offset_y = excluded.offset_y, updated_by = public.current_email(), updated_at = now();
end $$;

create or replace function public.save_check_asset(
  p_kind text, p_account text, p_base64 text, p_mime text, p_file_name text default null,
  p_transit_char text default null, p_onus_char text default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare v_bytes bytea;
begin
  perform public.require_admin();
  if p_kind = 'signature' and p_mime not in ('image/png','image/jpeg') then raise exception 'The signature has to be a PNG or JPG image'; end if;
  if p_kind = 'micr_font' and p_mime not in ('font/ttf','font/otf','application/octet-stream','application/x-font-ttf','font/sfnt') then
    raise exception 'The MICR font has to be a TTF or OTF file';
  end if;
  v_bytes := decode(p_base64, 'base64');
  if length(v_bytes) > 1048576 then raise exception 'That file is over 1 MB'; end if;
  insert into public.check_assets (org_id, kind, account_id, file_name, mime, content, transit_char, onus_char)
  values (public.current_org_id(), p_kind, case when p_kind = 'signature' then coalesce(p_account, '') else '' end,
          p_file_name, p_mime, v_bytes, left(nullif(p_transit_char, ''), 1), left(nullif(p_onus_char, ''), 1))
  on conflict (org_id, kind, account_id) do update
  set file_name = excluded.file_name, mime = excluded.mime, content = excluded.content,
      transit_char = excluded.transit_char, onus_char = excluded.onus_char, updated_by = public.current_email(), updated_at = now();
end $$;

create or replace function public.check_asset(p_kind text, p_account text default '')
returns table (file_name text, mime text, data text, transit_char text, onus_char text, updated_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.require_admin();
  return query
  select a.file_name, a.mime, encode(a.content, 'base64'), a.transit_char, a.onus_char, a.updated_at
  from public.check_assets a
  where a.org_id = public.current_org_id() and a.kind = p_kind and a.account_id = coalesce(p_account, '');
end $$;

-- ---------------------------------------------------------------------------
-- Checks. Each number is used once per account, even when the check is voided.
-- ---------------------------------------------------------------------------
create table public.checks (
  id            text not null default public.short_id(),
  org_id        uuid not null default public.current_org_id() references public.organizations(id),
  account_id    text not null,
  check_number  integer not null,
  expense_id    text not null,
  payee         text not null,
  amount        numeric(12,2) not null check (amount > 0),
  memo          text,
  check_date    date not null,
  status        text not null default 'outstanding' check (status in ('outstanding','cleared','voided','lost')),
  status_reason text,
  status_by     text,
  status_at     timestamptz,
  issued_by     text default public.current_email(),
  issued_at     timestamptz not null default now(),
  primary key (org_id, id),
  unique (org_id, account_id, check_number),
  foreign key (org_id, account_id) references public.accounts (org_id, id) on update cascade,
  foreign key (org_id, expense_id) references public.expenses (org_id, id)
);
create index checks_org_expense_idx on public.checks (org_id, expense_id);
create index checks_org_outstanding_idx on public.checks (org_id, account_id) where status = 'outstanding';

create or replace function public.issue_check(p_payout text, p_account text, p_memo text default null)
returns table (check_id text, check_number integer)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  e public.expenses;
  s public.account_check_settings;
  v_id text;
begin
  perform public.require_admin();
  select * into e from public.expenses x where x.org_id = v_org and x.id = p_payout and x.deleted_at is null for update;
  if e.id is null then raise exception 'Payout not found'; end if;
  if nullif(trim(e.payee), '') is null then raise exception 'Choose who the check is to first'; end if;
  if exists (select 1 from public.checks k where k.org_id = v_org and k.expense_id = e.id and k.status in ('outstanding','cleared')) then
    raise exception 'This payout already has a check. Void it first to print another';
  end if;
  select * into s from public.account_check_settings x where x.org_id = v_org and x.account_id = p_account for update;
  if s.routing_number is null or s.account_number is null or s.next_check_number is null then
    raise exception 'Set this account''s routing number, account number and starting check number first, under Accounts';
  end if;
  insert into public.checks (org_id, account_id, check_number, expense_id, payee, amount, memo, check_date)
  values (v_org, p_account, s.next_check_number, e.id, trim(e.payee), e.amount, coalesce(nullif(trim(p_memo), ''), e.memo),
          public.org_today())
  returning id into v_id;
  update public.account_check_settings x set next_check_number = s.next_check_number + 1
  where x.org_id = v_org and x.account_id = p_account;
  update public.expenses x set check_number = s.next_check_number::text, account_id = p_account, method = 'Check', cleared = false
  where x.org_id = v_org and x.id = e.id;
  return query select v_id, s.next_check_number;
end $$;

create or replace function public.set_check_status(p_check text, p_status text, p_reason text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  k public.checks;
begin
  perform public.require_admin();
  if p_status not in ('outstanding','cleared','voided','lost') then raise exception 'Unknown check status'; end if;
  select * into k from public.checks x where x.org_id = v_org and x.id = p_check for update;
  if k.id is null then raise exception 'Check not found'; end if;
  if k.status in ('voided','lost') then raise exception 'A % check stays that way. Its number isn''t used again', k.status; end if;
  if p_status in ('voided','lost') and nullif(trim(p_reason), '') is null then raise exception 'Give a reason'; end if;
  update public.checks set status = p_status, status_reason = nullif(trim(p_reason), ''), status_by = public.current_email(), status_at = now()
  where org_id = v_org and id = p_check;
  update public.expenses set cleared = (p_status = 'cleared') where org_id = v_org and id = k.expense_id;
end $$;

-- Marking a payout cleared (as the Task Sheet does) clears its check too.
create or replace function public.sync_check_cleared() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.cleared is true and old.cleared is not true then
    update public.checks set status = 'cleared', status_by = public.current_email(), status_at = now()
    where org_id = new.org_id and expense_id = new.id and status = 'outstanding';
  end if;
  return new;
end $$;
create trigger sync_check_cleared after update of cleared on public.expenses
  for each row execute function public.sync_check_cleared();

create view public.check_register with (security_invoker = true) as
select k.*, a.name as account_name, e.campaign_id, c.internal_name as campaign_name, e.payee_id,
       case when k.status = 'outstanding' then public.org_today() - k.check_date end as days_outstanding
from public.checks k
join public.accounts a on a.org_id = k.org_id and a.id = k.account_id
left join public.expenses e on e.org_id = k.org_id and e.id = k.expense_id
left join public.campaigns c on c.org_id = e.org_id and c.id = e.campaign_id;

-- ---------------------------------------------------------------------------
-- The Task Sheet: date-only items show at midnight where the organization is, and a voided or lost
-- check is no longer stale
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
alter table public.account_check_settings enable row level security;
alter table public.check_assets           enable row level security;
alter table public.checks                 enable row level security;
revoke all on public.account_check_settings, public.check_assets, public.checks from anon;
revoke insert, update, delete on public.account_check_settings, public.check_assets, public.checks from authenticated;
-- Files come back through check_asset(), never as raw rows.
revoke select on public.check_assets from authenticated;

do $$
declare t text;
begin
  foreach t in array array['account_check_settings','check_assets','checks'] loop
    execute format('create policy org_wall on public.%I as restrictive for all to authenticated
                    using (org_id = (select public.current_org_id()))
                    with check (org_id = (select public.current_org_id()))', t);
  end loop;
end $$;
create trigger log_row_change after insert or update or delete on public.account_check_settings for each row execute function public.log_row_change();
create trigger log_row_change after insert or update or delete on public.checks for each row execute function public.log_row_change();

create policy admin_read on public.account_check_settings for select to authenticated using ((select public.is_admin()));
create policy admin_read on public.checks for select to authenticated using ((select public.is_admin()));

revoke all on public.check_register from anon;
grant select on public.check_register to authenticated;

revoke execute on function public.sync_check_cleared() from public, anon, authenticated;
do $$
declare f text;
begin
  foreach f in array array[
    'org_midnight(date)',
    'save_check_settings(text, text, text, text, text, text, integer, numeric, numeric)',
    'save_check_asset(text, text, text, text, text, text, text)',
    'check_asset(text, text)',
    'issue_check(text, text, text)',
    'set_check_status(text, text, text)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
