-- Donary schedules (AppSheet gap review #6, Berel, 2026-11-18; approved by Shulim 2026-11-19).
-- A Donary schedule ("10 × Monthly, $100 in all") was only its first payment here: the schedule itself, and the
-- payments still to come, weren't kept anywhere, so Recurring and "upcoming" didn't show Donary-run recurrences.
--
-- donary_schedules keeps each schedule as Donary sent it. It's read-only: Donary charges it, not Donor Base, and
-- each payment it takes arrives as its own donation, as before. Its first payment is linked to it
-- (donations.donary_schedule_id); a later payment is linked when Donary sends the schedule's ID with it
-- (scheduleUniqueID). No payment is ever matched to a schedule by guesswork (amount, donor or date).
-- Both ways schedules come in save them: the direct Donary webhook (donary_apply) and the Make feed (make_ingest),
-- whose rows stay test data that delete_test_import removes, like the rest of what Make sends.
-- Admins see every schedule; a fundraiser sees the ones on their own campaigns.

create table if not exists public.donary_schedules (
  org_id        uuid not null references public.organizations(id),
  id            text not null default public.short_id(),
  schedule_uid  text not null,                    -- Donary's scheduleUniqueID
  campaign_id   text,
  donor_id      text,
  name          text,
  amount        numeric(12,2),                    -- each payment
  total_amount  numeric(12,2),
  payments_total integer,                         -- countOfSchedules
  frequency     text,                             -- as Donary says it: Monthly, Weekly...
  start_date    date,
  currency      text not null default 'USD',
  status        text not null default 'active' check (status in ('active', 'cancelled', 'completed')),
  came_from     text not null default 'Donary' check (came_from in ('Donary', 'Make')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (org_id, id),
  unique (org_id, schedule_uid)
);
alter table public.donary_schedules enable row level security;
revoke all on public.donary_schedules from anon, authenticated;
grant select on public.donary_schedules to authenticated;
drop policy if exists org_wall on public.donary_schedules;
create policy org_wall on public.donary_schedules as restrictive for select to authenticated
  using (org_id = (select public.current_org_id()));
drop policy if exists see_schedules on public.donary_schedules;
create policy see_schedules on public.donary_schedules for select to authenticated
  using ((select public.is_admin()) or campaign_id = any((select public.my_campaign_ids())::text[]));

alter table public.donations add column if not exists donary_schedule_id text;
create index if not exists donations_donary_schedule on public.donations (org_id, donary_schedule_id) where donary_schedule_id is not null;

-- How far apart a schedule's payments are, from Donary's frequency word; null when it isn't one we know.
create or replace function public.donary_step(p_frequency text) returns interval
language sql immutable set search_path = '' as $$
  select case lower(regexp_replace(coalesce(p_frequency, ''), '[^a-z]', '', 'gi'))
    when 'daily' then interval '1 day' when 'weekly' then interval '7 days'
    when 'biweekly' then interval '14 days' when 'everyotherweek' then interval '14 days'
    when 'monthly' then interval '1 month' when 'bimonthly' then interval '2 months'
    when 'quarterly' then interval '3 months' when 'semiannually' then interval '6 months'
    when 'yearly' then interval '1 year' when 'annually' then interval '1 year' when 'annual' then interval '1 year'
  end
$$;

-- Saves (or refreshes) a schedule from what Donary sent, and returns its id. p is the schedule payload.
create or replace function public.donary_save_schedule(p_org uuid, p jsonb, p_came_from text, p_campaign text, p_donor text, p_name text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_uid text := nullif(trim(p ->> 'scheduleUniqueID'), ''); v_id text; v_count integer; v_total numeric; v_each numeric;
begin
  if v_uid is null then return null; end if;
  v_count := nullif(regexp_replace(coalesce(p ->> 'countOfSchedules', ''), '[^0-9]', '', 'g'), '')::integer;
  v_total := public.make_num(p ->> 'totalScheduleAmount');
  v_each := coalesce(public.make_num(p -> 'firstPayment' ->> 'amount'), case when v_count > 0 then round(v_total / v_count, 2) end);
  insert into public.donary_schedules as x (org_id, schedule_uid, campaign_id, donor_id, name, amount, total_amount, payments_total,
                                            frequency, start_date, currency, came_from)
  values (p_org, v_uid, p_campaign, p_donor, nullif(trim(p_name), ''), v_each, v_total, v_count, nullif(trim(p ->> 'frequency'), ''),
          nullif(left(coalesce(p ->> 'scheduleStartDate', ''), 10), '')::date, coalesce(nullif(upper(trim(p ->> 'currency')), ''), 'USD'), p_came_from)
  on conflict (org_id, schedule_uid) do update
    set campaign_id = coalesce(excluded.campaign_id, x.campaign_id), donor_id = coalesce(excluded.donor_id, x.donor_id),
        name = coalesce(excluded.name, x.name), amount = coalesce(excluded.amount, x.amount),
        total_amount = coalesce(excluded.total_amount, x.total_amount), payments_total = coalesce(excluded.payments_total, x.payments_total),
        frequency = coalesce(excluded.frequency, x.frequency), start_date = coalesce(excluded.start_date, x.start_date), updated_at = now()
  returning id into v_id;
  return v_id;
end $$;
revoke execute on function public.donary_save_schedule(uuid, jsonb, text, text, text, text) from public, anon, authenticated;

-- A payment that names its schedule: link it (only when that schedule is on file).
create or replace function public.donary_link_payment(p_org uuid, p_donation text, p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare v_sid text;
begin
  if p_donation is null or nullif(trim(p ->> 'scheduleUniqueID'), '') is null then return; end if;
  select s.id into v_sid from public.donary_schedules s where s.org_id = p_org and s.schedule_uid = trim(p ->> 'scheduleUniqueID');
  if v_sid is not null then
    update public.donations set donary_schedule_id = v_sid where org_id = p_org and id = p_donation and donary_schedule_id is distinct from v_sid;
  end if;
end $$;
revoke execute on function public.donary_link_payment(uuid, text, jsonb) from public, anon, authenticated;

-- The direct webhook: save the schedule, link its first payment; link a charge that names its schedule.
do $$
declare v_def text; v_new text;
begin
  select pg_get_functiondef('public.donary_apply'::regproc) into v_def;
  v_new := replace(v_def,
    $s$    v_id := public.donary_record_charge(p_org, p);
    return jsonb_build_object('status', 'recorded', 'donation_id', v_id);$s$,
    $s$    v_id := public.donary_record_charge(p_org, p);
    perform public.donary_link_payment(p_org, v_id, p);
    return jsonb_build_object('status', 'recorded', 'donation_id', v_id);$s$);
  if v_new = v_def then raise exception 'donary_apply: charge branch not found'; end if;
  v_def := v_new;
  v_new := replace(v_def,
    $s$    -- A schedule: Donary runs it (recommended setting), so only a first payment taken today becomes a donation.
    if public.dobj(p, 'firstPayment') is not null then$s$,
    $s$    -- A schedule: Donary runs it (recommended setting), so only a first payment taken today becomes a donation.
    -- The schedule itself is kept (read-only) in donary_schedules, and its payments are linked to it.
    v_campaign := public.donary_campaign(p_org, p);
    v_sched := public.donary_save_schedule(p_org, p, 'Donary', v_campaign, public.donary_donor(p_org, p),
      nullif(trim(concat_ws(' ', public.dj(public.dobj(p, 'donorInfo'), 'firstName'), public.dj(public.dobj(p, 'donorInfo'), 'lastName'))), ''));
    if public.dobj(p, 'firstPayment') is not null then$s$);
  if v_new = v_def then raise exception 'donary_apply: schedule branch not found'; end if;
  v_def := v_new;
  v_new := replace(v_def,
    $s$                              'reasonInfo', public.dobj(p, 'reasonInfo'), 'currency', public.dj(p, 'currency')));
      return jsonb_build_object('status', 'recorded', 'donation_id', v_id,$s$,
    $s$                              'reasonInfo', public.dobj(p, 'reasonInfo'), 'currency', public.dj(p, 'currency')));
      if v_sched is not null then
        update public.donations set donary_schedule_id = v_sched where org_id = p_org and id = v_id;
      end if;
      return jsonb_build_object('status', 'recorded', 'donation_id', v_id, 'schedule_id', v_sched,$s$);
  if v_new = v_def then raise exception 'donary_apply: first payment not found'; end if;
  v_def := v_new;
  v_new := replace(v_def,
    $s$    return jsonb_build_object('status', 'recorded',
      'detail', format('%s × %s from %s, %s in all',$s$,
    $s$    return jsonb_build_object('status', 'recorded', 'schedule_id', v_sched,
      'detail', format('%s × %s from %s, %s in all',$s$);
  if v_new = v_def then raise exception 'donary_apply: schedule reply not found'; end if;
  v_def := v_new;
  v_new := replace(v_def, 'declare v_id text; v_campaign text; v_amount numeric; v_status text;',
                          'declare v_id text; v_campaign text; v_amount numeric; v_status text; v_sched text;');
  if v_new = v_def then raise exception 'donary_apply: declare not found'; end if;
  execute v_new;
end $$;

-- Make's schedules are test data like the rest of what Make sends.
alter table public.test_import_rows drop constraint if exists test_import_rows_table_name_check;
alter table public.test_import_rows add constraint test_import_rows_table_name_check check (table_name = any (array['accounts', 'sources',
  'managers', 'collectors', 'donors', 'campaigns', 'donations', 'expenses', 'transfers', 'pledges', 'tasks', 'donary_schedules']));

-- The Make feed: the same, and the schedule is marked as Make test data so the test wipe removes it.
do $$
declare v_def text; v_new text;
begin
  select pg_get_functiondef('public.make_ingest'::regproc) into v_def;
  v_new := replace(v_def,
    $s$          'created_at', public.local_time_text(coalesce(b ->> 'processedDateTime', fp ->> 'processedDateTime', b ->> 'deviceCreatedDate'), p_org)));
        v_out := jsonb_build_object('outcome', 'created', 'record_id', v_id);
      end if;$s$,
    $s$          'created_at', public.local_time_text(coalesce(b ->> 'processedDateTime', fp ->> 'processedDateTime', b ->> 'deviceCreatedDate'), p_org)));
        v_out := jsonb_build_object('outcome', 'created', 'record_id', v_id);
      end if;
      if p_source = 'donary-schedule' then
        v_campaign := public.make_campaign(p_org, public.make_first(b -> 'campaignInfo') ->> 'campaignNumber');
        v_existing := public.donary_save_schedule(p_org, b, 'Make', v_campaign, null,
          coalesce(nullif(trim(b ->> 'cardHolderName'), ''), nullif(trim(concat_ws(' ', di ->> 'firstName', di ->> 'lastName')), '')));
        if v_existing is not null then
          insert into public.test_import_rows (batch_id, table_name, record_id, source_sheet, source_id)
          select s.batch_id, 'donary_schedules', v_existing, 'make:donary-schedule', b ->> 'scheduleUniqueID'
          where not exists (select 1 from public.test_import_rows r where r.batch_id = s.batch_id and r.table_name = 'donary_schedules' and r.record_id = v_existing);
          update public.donations set donary_schedule_id = v_existing
          where org_id = p_org and id = coalesce(v_out ->> 'record_id', '') and donary_schedule_id is null;
          v_out := v_out || jsonb_build_object('schedule_id', v_existing);
        end if;
      else
        perform public.donary_link_payment(p_org, v_out ->> 'record_id', b);
      end if;$s$);
  if v_new = v_def then raise exception 'make_ingest: donary payment branch not found'; end if;
  execute v_new;
end $$;

-- The test wipe removes Make's schedules too.
do $$
declare v_def text; v_new text;
begin
  select pg_get_functiondef('public.delete_test_import'::regproc) into v_def;
  v_new := replace(v_def, $s$array['donations','pledges',$s$, $s$array['donations','donary_schedules','pledges',$s$);
  if v_new = v_def then raise exception 'delete_test_import: table list not found'; end if;
  execute v_new;
end $$;

-- The list: each schedule with the payments seen so far and when the next one is expected.
create or replace view public.donary_schedule_list with (security_invoker = true) as
select s.*,
  coalesce(c.internal_name, c.external_name, c.campaign_name, s.campaign_id) || coalesce(' (' || s.campaign_id || ')', '') as campaign_label,
  coalesce(dn.display_name, s.name, '') as donor_name,
  coalesce(p.n, 0) as payments_seen,
  coalesce(p.paid, 0) as paid,
  p.last_paid_at,
  case when s.status = 'active' and (s.payments_total is null or coalesce(p.n, 0) < s.payments_total) and public.donary_step(s.frequency) is not null
            and s.start_date is not null
       then (s.start_date + public.donary_step(s.frequency) * coalesce(p.n, 0))::date end as next_expected,
  case when s.payments_total is not null then greatest(s.payments_total - coalesce(p.n, 0), 0) end as payments_left
from public.donary_schedules s
left join public.campaigns c on c.org_id = s.org_id and c.id = s.campaign_id
left join public.donors dn on dn.org_id = s.org_id and dn.id = s.donor_id
left join lateral (
  select count(*) as n, sum(d.amount) as paid, max(d.created_at) as last_paid_at
  from public.donations d
  where d.org_id = s.org_id and d.donary_schedule_id = s.id and d.deleted_at is null and d.status in ('completed', 'collect')
) p on true;
grant select on public.donary_schedule_list to authenticated;
