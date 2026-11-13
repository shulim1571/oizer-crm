-- Phase 7 part 2: what the system tells people on its own. A minute job sends donation and refund alerts to
-- each campaign's fundraisers (never for Donary machine payments, which get a nightly summary instead) and
-- to admins who asked for them, and alerts admins to new Task Sheet items. The same job sends the timed
-- emails in each organization's own time zone: the morning Task Sheet digest and task reminders, the
-- admin donation digest, Sunday's open pledge and voucher digests, and the nightly machine summary.
-- Decisions on campaign requests, team changes, payout requests and machine bookings are emailed as they
-- happen. Everything goes through queue_message, so test mode and opt-outs apply.

-- ---------------------------------------------------------------------------
-- Preferences, one row per person who signs in. No row means the defaults.
-- ---------------------------------------------------------------------------
create table public.notification_preferences (
  org_id            uuid not null default public.current_org_id() references public.organizations(id),
  user_id           uuid not null default auth.uid(),
  phone             text,
  donation_alerts   text not null default 'off' check (donation_alerts in ('off','all','over')),
  donation_min      numeric(12,2),
  donation_campaigns text[],
  donation_digest   text not null default 'off' check (donation_digest in ('off','daily','weekly')),
  task_alerts       text not null default 'both' check (task_alerts in ('immediate','digest','both','off')),
  payout_alerts     text not null default 'immediate' check (payout_alerts in ('immediate','digest','off')),
  weekly_digests    boolean not null default true,
  channels          jsonb not null default '{}',
  updated_at        timestamptz not null default now(),
  primary key (org_id, user_id)
);

-- Which donations have had their alert, so none goes twice.
create table public.donation_notices (
  org_id       uuid not null references public.organizations(id),
  donation_id  text not null,
  kind         text not null check (kind in ('donation','refund')),
  created_at   timestamptz not null default now(),
  primary key (org_id, donation_id, kind)
);

-- Task Sheet items already announced, and when each was first seen.
create table public.task_sheet_seen (
  org_id         uuid not null references public.organizations(id),
  task_key       text not null,
  task_type      text not null,
  first_seen_at  timestamptz not null default now(),
  primary key (org_id, task_key)
);

-- What each organization's timed emails last did. Alerts cover only what happened after this part went in.
create table public.notification_state (
  org_id              uuid primary key references public.organizations(id),
  since               timestamptz not null default now(),
  tasks_ready         boolean not null default false,
  last_morning        date,
  last_weekly         date,
  last_machine_digest date
);

-- ---------------------------------------------------------------------------
-- Building blocks
-- ---------------------------------------------------------------------------
create or replace function public.html_escape(p text) returns text
language sql immutable as $$
  select replace(replace(replace(replace(replace(coalesce(p, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;'), '''', '&#39;')
$$;

create or replace function public.money_text(p numeric) returns text
language sql immutable as $$
  select case when p < 0 then '-' else '' end || '$' || trim(to_char(abs(coalesce(p, 0)), 'FM999,999,999,990.00'))
$$;

create or replace function public.org_zone(p_org uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((select s.value #>> '{}' from public.settings s where s.org_id = p_org and s.key = 'timezone'), 'America/New_York')
$$;

-- The portal's address for links in emails: the organization's own web address.
create or replace function public.portal_url(p_org uuid) returns text
language sql stable security definer set search_path = '' as $$
  select 'https://' || d.hostname || '/' from public.org_domains d where d.org_id = p_org order by d.hostname limit 1
$$;

-- A plain, branded email: heading, lines of already-escaped HTML, and an optional button.
create or replace function public.notice_html(p_org uuid, p_heading text, p_lines text[], p_link text default null, p_link_label text default null)
returns text
language sql stable security definer set search_path = '' as $$
  select '<!doctype html><html><body style="margin:0;background:#f5f6f8;font-family:Arial,Helvetica,sans-serif;color:#111">'
    || '<div style="max-width:560px;margin:0 auto;padding:24px 16px">'
    || '<div style="font-size:13px;color:#555;margin-bottom:10px">'
    || case when o.logo_url is not null then '<img src="' || public.html_escape(o.logo_url) || '" alt="" style="max-height:36px;vertical-align:middle;margin-right:8px">' else '' end
    || public.html_escape(o.name) || '</div>'
    || '<div style="background:#fff;border:1px solid #e7e9ee;border-radius:10px;padding:20px">'
    || '<h1 style="font-size:18px;margin:0 0 12px">' || public.html_escape(p_heading) || '</h1>'
    || array_to_string(array(select '<p style="margin:6px 0;line-height:1.45">' || l || '</p>' from unnest(p_lines) l), '')
    || case when p_link is not null then
         '<p style="margin:18px 0 4px"><a href="' || public.html_escape(p_link) || '" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:9px 16px;border-radius:7px;font-size:14px">'
         || public.html_escape(coalesce(p_link_label, 'Open in the portal')) || '</a></p>' else '' end
    || '</div><div style="font-size:11px;color:#888;margin-top:10px">Sent by the ' || public.html_escape(o.name) || ' campaign portal.</div>'
    || '</div></body></html>'
  from public.organizations o where o.id = p_org
$$;

-- Turns the HTML lines back into readable text for the plain part of the email and for texts.
create or replace function public.notice_text(p_heading text, p_lines text[], p_link text default null) returns text
language sql immutable as $$
  select p_heading || E'\n\n'
    || array_to_string(array(
         select replace(replace(replace(replace(replace(regexp_replace(l, '<[^>]+>', '', 'g'), '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '&#39;', ''''), '&amp;', '&')
         from unnest(p_lines) l), E'\n')
    || coalesce(E'\n\n' || p_link, '')
$$;

-- Sends one notice to one person by the channel they chose for this kind: email, text or both. A text
-- choice without a phone falls back to email. A bad address is skipped, never breaking what triggered it.
create or replace function public.notify_person(
  p_org uuid, p_email text, p_phone text, p_name text, p_channel text,
  p_kind text, p_subject text, p_lines text[], p_link text default null, p_link_label text default null,
  p_record text default null, p_campaign text default null, p_donor text default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_channel text := coalesce(p_channel, 'email');
  v_email boolean := v_channel in ('email','both') or (v_channel = 'sms' and public.normalize_phone(p_phone) is null);
  v_sms boolean := v_channel in ('sms','both') and public.normalize_phone(p_phone) is not null;
begin
  if v_email and public.normalize_address('email', p_email) is not null then
    begin
      perform public.queue_message(p_org, 'email', p_email, p_name, p_subject, public.notice_text(p_subject, p_lines, p_link),
        public.notice_html(p_org, p_subject, p_lines, p_link, p_link_label), p_kind, p_record, p_donor, p_campaign);
    exception when others then null;
    end;
  end if;
  if v_sms then
    begin
      perform public.queue_message(p_org, 'sms', p_phone, p_name, null,
        left(public.notice_text(p_subject, p_lines, p_link), 600), null, p_kind, p_record, p_donor, p_campaign);
    exception when others then null;
    end;
  end if;
end $$;

-- Active admins and the preferences each one chose.
create or replace function public.notice_admins(p_org uuid)
returns table (user_id uuid, email text, name text, phone text, prefs public.notification_preferences)
language sql stable security definer set search_path = '' as $$
  select m.user_id, u.email, coalesce(nullif(trim(u.raw_user_meta_data ->> 'full_name'), ''), u.email), p.phone,
         coalesce(p, row(p_org, m.user_id, null, 'off', null, null, 'off', 'both', 'immediate', true, '{}'::jsonb, now())::public.notification_preferences)
  from public.org_members m
  join auth.users u on u.id = m.user_id
  left join public.notification_preferences p on p.org_id = m.org_id and p.user_id = m.user_id
  where m.org_id = p_org and m.role in ('super_admin','admin') and m.status = 'active'
$$;

-- A campaign's fundraisers, primary first, plus the team of the campaign it belongs to. The channel is
-- the one their login chose for this kind of notice.
create or replace function public.notice_team(p_org uuid, p_campaign text, p_kind text)
returns table (manager_id text, email text, phone text, name text, channel text, is_primary boolean)
language sql stable security definer set search_path = '' as $$
  with c as (
    select x.id, x.manager_id, x.sub_manager_ids, x.parent_campaign_id from public.campaigns x
    where x.org_id = p_org and x.id = p_campaign
  ), ids as (
    select c.manager_id as id, true as is_primary, 0 as rank from c
    union all select unnest(c.sub_manager_ids), false, 1 from c
    union all select p.manager_id, false, 2 from c join public.campaigns p on p.org_id = p_org and p.id = c.parent_campaign_id
  ), uniq as (
    select distinct on (id) id, is_primary, rank from ids where id is not null order by id, rank
  )
  select m.id, m.email, m.phone, m.full_name,
         coalesce((select np.channels ->> p_kind from public.user_managers um
                   join public.notification_preferences np on np.org_id = p_org and np.user_id = um.user_id
                   where um.org_id = p_org and um.manager_id = m.id limit 1), 'email'),
         u.is_primary
  from uniq u
  join public.managers m on m.org_id = p_org and m.id = u.id
  where m.deleted_at is null and coalesce(m.status, 'active') = 'active'
  order by u.rank, m.full_name
$$;

create or replace function public.campaign_label(p_org uuid, p_campaign text) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(c.internal_name, c.external_name, c.campaign_name, c.id) || ' (' || c.id || ')'
  from public.campaigns c where c.org_id = p_org and c.id = p_campaign
$$;

-- ---------------------------------------------------------------------------
-- Donation and refund alerts
-- ---------------------------------------------------------------------------
create or replace function public.notify_donations(p_org uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  st public.notification_state;
  d record;
  t record;
  a record;
  v_count integer := 0;
  v_portal text := public.portal_url(p_org);
  v_zone text := public.org_zone(p_org);
  v_lines text[];
  v_donor text;
  v_when text;
  v_balance numeric;
begin
  select * into st from public.notification_state where org_id = p_org;
  for d in
    select x.*, case when x.status = 'completed' then 'donation' else 'refund' end as notice,
           exists (select 1 from public.machines mc where mc.org_id = x.org_id and mc.source_id = x.source) as machine
    from public.donations x
    where x.org_id = p_org and x.deleted_at is null and x.campaign_id is not null
      and coalesce(x.payment_method, '') <> 'Opening Balance'
      and (
        (x.status = 'completed' and greatest(x.created_at, coalesce(x.reviewed_at, x.created_at)) > st.since
         and greatest(x.created_at, coalesce(x.reviewed_at, x.created_at)) > now() - interval '3 days')
        or (x.status in ('refunded','returned') and x.updated_at > st.since and x.updated_at > now() - interval '3 days')
      )
      and not exists (select 1 from public.donation_notices n where n.org_id = x.org_id and n.donation_id = x.id
                      and n.kind = case when x.status = 'completed' then 'donation' else 'refund' end)
      and not exists (select 1 from public.import_records r where r.org_id = x.org_id and r.table_name = 'donations' and r.record_id = x.id)
    order by x.created_at
    limit 500
  loop
    insert into public.donation_notices (org_id, donation_id, kind) values (p_org, d.id, d.notice) on conflict do nothing;
    v_count := v_count + 1;
    v_donor := case when d.anonymous then 'Anonymous'
                    else coalesce((select dn.display_name from public.donors dn where dn.org_id = p_org and dn.id = d.donor_id), nullif(trim(d.name), ''), 'A donor') end;
    v_when := to_char(coalesce(d.reviewed_at, d.created_at) at time zone v_zone, 'FMMon FMDD, YYYY "at" FMHH12:MI AM');

    if d.notice = 'refund' then
      -- Only the campaign whose money went back hears about it.
      v_lines := array[
        '<b>' || public.money_text(d.amount) || '</b> from ' || public.html_escape(v_donor) || ' was '
          || case d.status when 'returned' then 'returned by the bank' else 'refunded' end || '.',
        'Campaign: ' || public.html_escape(public.campaign_label(p_org, d.campaign_id)),
        coalesce('Reason: ' || public.html_escape(nullif(d.reversal_reason, '')), 'Payment method: ' || public.html_escape(coalesce(d.payment_method, '—')))];
      for t in select * from public.notice_team(p_org, d.campaign_id, 'donations') where manager_id in
                 (select c.manager_id from public.campaigns c where c.org_id = p_org and c.id = d.campaign_id
                  union select unnest(c.sub_manager_ids) from public.campaigns c where c.org_id = p_org and c.id = d.campaign_id) loop
        perform public.notify_person(p_org, t.email, t.phone, t.name, t.channel, 'refund',
          case d.status when 'returned' then 'Returned payment on ' else 'Refund on ' end || public.campaign_label(p_org, d.campaign_id),
          v_lines, v_portal || '#/campaigns/' || d.campaign_id, 'Open the campaign', d.id, d.campaign_id, d.donor_id);
      end loop;
      continue;
    end if;

    -- Fundraisers: every donation except Donary machine payments, which come in the nightly summary.
    if not d.machine then
      v_lines := array[
        '<b>' || public.money_text(d.amount) || '</b> from ' || public.html_escape(v_donor),
        'Payment method: ' || public.html_escape(coalesce(d.payment_method, '—')),
        'Received: ' || v_when];
      for t in select * from public.notice_team(p_org, d.campaign_id, 'donations') loop
        perform public.notify_person(p_org, t.email, t.phone, t.name, t.channel, 'donation',
          'New donation to ' || public.campaign_label(p_org, d.campaign_id), v_lines,
          case when d.donor_id is not null and not d.anonymous then v_portal || '#/donors/' || d.donor_id else v_portal || '#/campaigns/' || d.campaign_id end,
          case when d.donor_id is not null and not d.anonymous then 'Open the donor' else 'Open the campaign' end,
          d.id, d.campaign_id, d.donor_id);
      end loop;
    end if;

    -- Admins who asked: all donations, or those at or over their own amount, on all or chosen campaigns.
    for a in select * from public.notice_admins(p_org) x
             where (x.prefs).donation_alerts = 'all'
                or ((x.prefs).donation_alerts = 'over' and d.amount >= coalesce((x.prefs).donation_min, 0)) loop
      continue when (a.prefs).donation_campaigns is not null and not d.campaign_id = any((a.prefs).donation_campaigns);
      if v_balance is null then
        select case when s.pool_id is not null then (select s2.balance from public.campaign_summary s2 where s2.org_id = p_org and s2.id = s.pool_id) else s.balance end
        into v_balance from public.campaign_summary s where s.org_id = p_org and s.id = d.campaign_id;
      end if;
      perform public.notify_person(p_org, a.email, a.phone, a.name, (a.prefs).channels ->> 'donations', 'donation',
        'New donation to ' || public.campaign_label(p_org, d.campaign_id),
        array[
          '<b>' || public.money_text(d.amount) || '</b> from ' || public.html_escape(v_donor)
            || coalesce(' · ' || public.html_escape(nullif(trim(coalesce(d.email, d.phone)), '')), ''),
          'Fee ' || public.money_text(coalesce(d.fee, 0)) || ' · net ' || public.money_text(d.amount - coalesce(d.fee, 0)) || ' credited',
          'Payment method: ' || public.html_escape(coalesce(d.payment_method, '—'))
            || coalesce(' · ref ' || public.html_escape(nullif(coalesce(d.gateway_id, d.donary_id, d.check_number, d.bank_reference), '')), ''),
          'Campaign balance now ' || public.money_text(coalesce(v_balance, 0)),
          'Received: ' || v_when],
        v_portal || '#/campaigns/' || d.campaign_id, 'Open the campaign', d.id, d.campaign_id, d.donor_id);
    end loop;
    v_balance := null;
  end loop;
  return v_count;
end $$;

-- ---------------------------------------------------------------------------
-- Task Sheet alerts. The sheet is read as one of the organization's admins would see it.
-- ---------------------------------------------------------------------------
create or replace function public.as_org_admin(p_org uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_user uuid; v_email text;
begin
  select m.user_id, u.email into v_user, v_email from public.org_members m join auth.users u on u.id = m.user_id
  where m.org_id = p_org and m.role in ('super_admin','admin') and m.status = 'active' order by m.role desc, m.created_at limit 1;
  if v_user is null then return false; end if;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_user, 'email', v_email, 'role', 'authenticated')::text, true);
  perform set_config('request.headers', jsonb_build_object('x-org-id', p_org)::text, true);
  return true;
end $$;

create or replace function public.notify_tasks(p_org uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  st public.notification_state;
  a record;
  v_new integer;
  v_items text[];
  v_portal text := public.portal_url(p_org);
begin
  select * into st from public.notification_state where org_id = p_org;
  if not public.as_org_admin(p_org) then return 0; end if;
  create temp table if not exists sheet_now (task_key text, task_type text, summary text, campaign text, amount numeric) on commit drop;
  truncate pg_temp.sheet_now;
  insert into pg_temp.sheet_now
  select s.task_key, s.task_type, s.summary, coalesce(s.campaign_name || ' (' || s.campaign_id || ')', ''), s.amount
  from public.admin_task_sheet s where not s.held;
  -- Items that left the sheet are forgotten; new ones are recorded.
  delete from public.task_sheet_seen x where x.org_id = p_org and not exists (select 1 from pg_temp.sheet_now n where n.task_key = x.task_key);
  with added as (
    insert into public.task_sheet_seen (org_id, task_key, task_type)
    select p_org, n.task_key, n.task_type from pg_temp.sheet_now n
    on conflict do nothing returning task_key
  ) select count(*) into v_new from added;
  -- The first run only learns what's already there.
  if not st.tasks_ready then
    update public.notification_state set tasks_ready = true where org_id = p_org;
    return 0;
  end if;
  if v_new > 0 then
    for a in select * from public.notice_admins(p_org) loop
      select array_agg(public.html_escape(public.task_type_label(n.task_type)) || ': ' || public.html_escape(n.summary)
                         || case when n.campaign <> '' then ' · ' || public.html_escape(n.campaign) else '' end
                         || coalesce(' · ' || public.money_text(n.amount), '') order by n.task_type)
      into v_items
      from pg_temp.sheet_now n join public.task_sheet_seen x on x.org_id = p_org and x.task_key = n.task_key
      where x.first_seen_at = now()
        and case when n.task_type = 'payout_request' then (a.prefs).payout_alerts = 'immediate'
                 else (a.prefs).task_alerts in ('immediate','both') end;
      continue when v_items is null;
      perform public.notify_person(p_org, a.email, a.phone, a.name, (a.prefs).channels ->> 'tasks', 'task_alert',
        case when cardinality(v_items) = 1 then 'New on the Task Sheet' else cardinality(v_items) || ' new items on the Task Sheet' end,
        v_items, v_portal || '#/task-sheet', 'Open the Task Sheet');
    end loop;
  end if;
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.headers', '', true);
  return v_new;
end $$;

create or replace function public.task_type_label(p text) returns text
language sql immutable as $$
  select case p
    when 'campaign_request' then 'Campaign request' when 'changes_resubmitted' then 'Changes resubmitted'
    when 'team_request' then 'Team request' when 'pending_payment' then 'Pending manual payment'
    when 'unattributed' then 'Unattributed payment' when 'returned_check' then 'Returned check'
    when 'post_dated_due' then 'Post-dated check due' when 'voucher_overdue' then 'Voucher overdue'
    when 'pledge_overdue' then 'Pledge overdue' when 'stale_check' then 'Stale check'
    when 'inactive_campaign' then 'Inactive campaign' when 'bank_reassign' then 'Bank account reassignment'
    when 'machine_booking' then 'Machine request' when 'payout_request' then 'Payout request'
    when 'scheduled_payout' then 'Scheduled payout due' when 'receipt_text_missing' then 'Receipt text not set up'
    when 'receipt_reissue' then 'Corrected receipt needed' when 'import_conflict' then 'Import data conflict'
    when 'delivery_failed' then 'Delivery failed'
    else initcap(replace(p, '_', ' ')) end
$$;

-- ---------------------------------------------------------------------------
-- Timed emails
-- ---------------------------------------------------------------------------
-- 8 AM: what has waited on the Task Sheet a day or more, the admin donation digest, and fundraisers' tasks due today.
create or replace function public.notify_morning(p_org uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  a record;
  f record;
  v_items text[];
  v_portal text := public.portal_url(p_org);
  v_zone text := public.org_zone(p_org);
  v_today date := (now() at time zone v_zone)::date;
  v_weekly boolean := extract(isodow from (now() at time zone v_zone)) = 7;
  v_from timestamptz;
begin
  if public.as_org_admin(p_org) then
    create temp table if not exists sheet_old (task_type text, summary text, campaign text, first_seen_at timestamptz) on commit drop;
    truncate pg_temp.sheet_old;
    insert into pg_temp.sheet_old
    select s.task_type, s.summary, coalesce(s.campaign_name || ' (' || s.campaign_id || ')', ''), x.first_seen_at
    from public.admin_task_sheet s join public.task_sheet_seen x on x.org_id = p_org and x.task_key = s.task_key
    where not s.held and x.first_seen_at < now() - interval '24 hours';
    for a in select * from public.notice_admins(p_org) loop
      select array_agg(public.html_escape(public.task_type_label(o.task_type)) || ': ' || public.html_escape(o.summary)
                         || case when o.campaign <> '' then ' · ' || public.html_escape(o.campaign) else '' end
                         || ' · waiting ' || (v_today - (o.first_seen_at at time zone v_zone)::date) || ' days' order by o.first_seen_at)
      into v_items
      from pg_temp.sheet_old o
      where case when o.task_type = 'payout_request' then (a.prefs).payout_alerts = 'digest'
                 else (a.prefs).task_alerts in ('digest','both') end;
      continue when v_items is null;
      perform public.notify_person(p_org, a.email, a.phone, a.name, (a.prefs).channels ->> 'digests', 'task_digest',
        cardinality(v_items) || ' Task Sheet item' || case when cardinality(v_items) = 1 then '' else 's' end || ' still waiting',
        v_items, v_portal || '#/task-sheet', 'Open the Task Sheet');
    end loop;
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.headers', '', true);
  end if;

  -- Donation digest: daily, or weekly on Sunday. Admins on "over" get the donations under their amount.
  for a in select * from public.notice_admins(p_org) x where (x.prefs).donation_digest = 'daily' or ((x.prefs).donation_digest = 'weekly' and v_weekly) loop
    v_from := now() - case when (a.prefs).donation_digest = 'weekly' then interval '7 days' else interval '1 day' end;
    select array_agg(r.line order by r.total desc) into v_items from (
      select public.html_escape(public.campaign_label(p_org, d.campaign_id)) || ': ' || count(*) || ' donation' || case when count(*) = 1 then '' else 's' end
               || ', ' || public.money_text(sum(d.amount)) as line, sum(d.amount) as total
      from public.donations d
      where d.org_id = p_org and d.status = 'completed' and d.deleted_at is null and d.campaign_id is not null
        and d.created_at >= v_from and coalesce(d.payment_method, '') <> 'Opening Balance'
        and ((a.prefs).donation_campaigns is null or d.campaign_id = any((a.prefs).donation_campaigns))
        and ((a.prefs).donation_alerts <> 'over' or d.amount < coalesce((a.prefs).donation_min, 0))
      group by d.campaign_id) r;
    continue when v_items is null;
    perform public.notify_person(p_org, a.email, a.phone, a.name, (a.prefs).channels ->> 'digests', 'donation_digest',
      'Donations ' || case when (a.prefs).donation_digest = 'weekly' then 'this past week' else 'yesterday' end, v_items,
      v_portal || '#/donations/recent', 'See recent donations');
  end loop;

  -- Fundraisers' own tasks due today.
  for f in
    select m.id, m.email, m.phone, m.full_name,
           array_agg(public.html_escape(k.title) || coalesce(' · ' || public.html_escape(public.campaign_label(p_org, k.campaign_id)), '') order by k.title) as items,
           (select np.channels ->> 'reminders' from public.user_managers um join public.notification_preferences np on np.org_id = p_org and np.user_id = um.user_id
            where um.org_id = p_org and um.manager_id = m.id limit 1) as channel
    from public.tasks k
    join public.managers m on m.org_id = k.org_id and m.id = coalesce(k.owner_manager_id, k.assigned_to)
    where k.org_id = p_org and k.deleted_at is null and k.status <> 'Done' and k.due_date = v_today
      and m.deleted_at is null and coalesce(m.status, 'active') = 'active'
    group by m.id, m.email, m.phone, m.full_name
  loop
    perform public.notify_person(p_org, f.email, f.phone, f.full_name, f.channel, 'task_reminder',
      case when cardinality(f.items) = 1 then 'A task is due today' else cardinality(f.items) || ' tasks are due today' end,
      f.items, v_portal || '#/tasks', 'Open your tasks');
  end loop;
end $$;

-- Sunday: open pledges and open vouchers, for admins who keep the weekly digests on.
create or replace function public.notify_weekly(p_org uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  a record;
  v_pledges text[];
  v_vouchers text[];
  v_portal text := public.portal_url(p_org);
begin
  select array_agg(public.html_escape(coalesce(p.reference, p.id)) || ' · ' || public.html_escape(coalesce(p.donor_name, 'No donor'))
                   || ' · ' || public.html_escape(coalesce(p.campaign_internal, p.campaign_id, '')) || ' · ' || public.money_text(p.balance) || ' open'
                   || case when p.status = 'overdue' then ' · <b>overdue</b>' else '' end order by p.status = 'overdue' desc, p.balance desc)
  into v_pledges
  from public.pledge_list p where p.org_id = p_org and p.status in ('open','partial','overdue');
  select array_agg(public.html_escape(v.id) || ' · ' || public.html_escape(replace(v.issuer, 'Voucher — ', '')) || ' · ' || public.html_escape(coalesce(v.donor_name, 'No donor'))
                   || ' · ' || public.money_text(v.remaining) || ' of ' || public.money_text(v.face_value) || ' unfunded'
                   || case when v.overdue then ' · <b>overdue</b>' else '' end order by v.overdue desc, v.remaining desc)
  into v_vouchers
  from public.voucher_list v where v.org_id = p_org and v.status in ('pending','partial');
  for a in select * from public.notice_admins(p_org) x where (x.prefs).weekly_digests loop
    if v_pledges is not null then
      perform public.notify_person(p_org, a.email, a.phone, a.name, (a.prefs).channels ->> 'digests', 'pledge_digest',
        cardinality(v_pledges) || ' open pledge' || case when cardinality(v_pledges) = 1 then '' else 's' end, v_pledges, v_portal || '#/pledges', 'Open pledges');
    end if;
    if v_vouchers is not null then
      perform public.notify_person(p_org, a.email, a.phone, a.name, (a.prefs).channels ->> 'digests', 'voucher_digest',
        cardinality(v_vouchers) || ' open voucher' || case when cardinality(v_vouchers) = 1 then '' else 's' end, v_vouchers, v_portal || '#/vouchers', 'Open vouchers');
    end if;
  end loop;
end $$;

-- Each evening: the day's Donary machine payments for each campaign, machine by machine.
create or replace function public.notify_machine_digest(p_org uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  c record;
  t record;
  v_zone text := public.org_zone(p_org);
  v_start timestamptz := ((now() at time zone v_zone)::date)::timestamp at time zone v_zone;
  v_portal text := public.portal_url(p_org);
begin
  for c in
    select x.campaign_id,
           array_agg('Machine ' || x.nickname || ': ' || x.n || ' transaction' || case when x.n = 1 then '' else 's' end || ' · ' || public.money_text(x.total) order by x.nickname) as lines,
           sum(x.n) as n, sum(x.total) as total
    from (
      select d.campaign_id, mc.nickname, count(*) as n, sum(d.amount) as total
      from public.donations d
      join public.machines mc on mc.org_id = d.org_id and mc.source_id = d.source
      where d.org_id = p_org and d.status = 'completed' and d.deleted_at is null and d.campaign_id is not null and d.created_at >= v_start
      group by d.campaign_id, mc.nickname
    ) x
    group by x.campaign_id
  loop
    for t in select * from public.notice_team(p_org, c.campaign_id, 'machine_digest') loop
      perform public.notify_person(p_org, t.email, t.phone, t.name, t.channel, 'machine_digest',
        'Today''s machine activity — ' || public.campaign_label(p_org, c.campaign_id),
        c.lines || ('<b>Total: ' || c.n || ' transaction' || case when c.n = 1 then '' else 's' end || ' · ' || public.money_text(c.total) || '</b>'),
        v_portal || '#/campaigns/' || c.campaign_id, 'Open the campaign', null, c.campaign_id);
    end loop;
  end loop;
end $$;

-- The minute job. Each organization's timed emails go out once a day at their hour in its own time zone.
create or replace function public.run_notifications() returns void
language plpgsql security definer set search_path = '' as $$
declare
  o record;
  v_local timestamp;
  v_digest time;
begin
  perform public.start_notifications();
  -- Wake the sender once at the end rather than for every message.
  perform set_config('app.batch_send', 'on', true);
  for o in select s.* from public.notification_state s join public.organizations g on g.id = s.org_id where g.status = 'active' loop
    begin
      perform public.notify_donations(o.org_id);
      perform public.notify_tasks(o.org_id);
      v_local := now() at time zone public.org_zone(o.org_id);
      if v_local::time >= time '08:00' and o.last_morning is distinct from v_local::date then
        update public.notification_state set last_morning = v_local::date where org_id = o.org_id;
        perform public.notify_morning(o.org_id);
      end if;
      if extract(isodow from v_local) = 7 and v_local::time >= time '08:00' and o.last_weekly is distinct from v_local::date then
        update public.notification_state set last_weekly = v_local::date where org_id = o.org_id;
        perform public.notify_weekly(o.org_id);
      end if;
      v_digest := coalesce((select (s.value #>> '{}')::time from public.settings s where s.org_id = o.org_id and s.key = 'machine_digest_time'), time '22:00');
      if v_local::time >= v_digest and o.last_machine_digest is distinct from v_local::date then
        update public.notification_state set last_machine_digest = v_local::date where org_id = o.org_id;
        perform public.notify_machine_digest(o.org_id);
      end if;
    exception when others then
      -- One organization's trouble doesn't stop the others; the failure is kept for the health check.
      insert into public.job_runs (job, finished_at, ok, error) values ('notifications', now(), false, o.org_id || ': ' || sqlerrm);
    end;
  end loop;
  perform set_config('app.batch_send', 'off', true);
  perform public.kick_sender_if_due();
end $$;

-- A new organization starts with today's timed emails counted as done, so nothing from before goes out.
create or replace function public.start_notifications() returns void
language sql security definer set search_path = '' as $$
  insert into public.notification_state (org_id, last_morning, last_weekly, last_machine_digest)
  select o.id, (now() at time zone public.org_zone(o.id))::date, (now() at time zone public.org_zone(o.id))::date, (now() at time zone public.org_zone(o.id))::date
  from public.organizations o
  on conflict do nothing
$$;

-- The sending engine's queue_message, now able to hold off waking the sender during a batch.
create or replace function public.queue_message(
  p_org uuid, p_channel text, p_to text, p_to_name text, p_subject text, p_body text, p_html text,
  p_kind text, p_record_id text default null, p_donor text default null, p_campaign text default null,
  p_send_after timestamptz default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_to text := public.normalize_address(p_channel, p_to);
  v_status text := 'queued';
  v_error text;
  v_id uuid;
  s public.messaging_settings;
begin
  if p_channel not in ('email','sms') then raise exception 'Choose email or text'; end if;
  if nullif(trim(p_to), '') is null then
    raise exception 'No % to send to', case p_channel when 'sms' then 'phone number' else 'email address' end;
  end if;
  if v_to is null then
    raise exception '"%" isn''t a valid %', p_to, case p_channel when 'sms' then 'phone number' else 'email address' end;
  end if;
  if nullif(trim(p_body), '') is null then raise exception 'The message is empty'; end if;
  select * into s from public.messaging_settings where org_id = p_org;
  if exists (select 1 from public.message_opt_outs o where o.org_id = p_org and o.channel = p_channel and o.address = v_to) then
    v_status := 'opted_out';
    v_error := 'This number replied STOP. It gets texts again after replying START';
  elsif not coalesce(s.live, false)
        and not exists (select 1 from unnest(coalesce(s.test_recipients, '{}')) t where public.normalize_address(p_channel, t) = v_to) then
    v_status := 'held';
    v_error := 'Held: sending is in test mode and this address isn''t on the test list';
  end if;
  insert into public.messages (org_id, channel, to_address, to_name, subject, body, html, kind, record_id, donor_id, campaign_id,
                               status, error, send_after)
  values (p_org, p_channel, v_to, nullif(trim(p_to_name), ''), nullif(trim(p_subject), ''), p_body, p_html, p_kind,
          p_record_id, p_donor, p_campaign, v_status, v_error, coalesce(p_send_after, now()))
  returning id into v_id;
  if v_status = 'queued' and coalesce(p_send_after, now()) <= now() and coalesce(current_setting('app.batch_send', true), '') <> 'on' then
    perform public.kick_sender();
  end if;
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- Emails sent the moment something is decided
-- ---------------------------------------------------------------------------
-- The fundraiser behind a request: their record if there is one, otherwise the login that asked.
create or replace function public.notice_requester(p_org uuid, p_manager text, p_email text, p_kind text)
returns table (email text, phone text, name text, channel text)
language sql stable security definer set search_path = '' as $$
  select coalesce(m.email, p_email), m.phone, coalesce(m.full_name, p_email),
         coalesce((select np.channels ->> p_kind from public.user_managers um join public.notification_preferences np on np.org_id = p_org and np.user_id = um.user_id
                   where um.org_id = p_org and um.manager_id = m.id limit 1), 'email')
  from (select 1) one
  left join public.managers m on m.org_id = p_org and m.id = p_manager and m.deleted_at is null
  where coalesce(m.email, p_email) is not null
$$;

create or replace function public.on_campaign_request_decided() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r record; v_portal text := public.portal_url(new.org_id);
begin
  if new.status is not distinct from old.status or new.status not in ('approved','rejected','changes_requested') then return new; end if;
  for r in select * from public.notice_requester(new.org_id, new.manager_id, new.requested_by_email, 'requests') loop
    perform public.notify_person(new.org_id, r.email, r.phone, r.name, r.channel, 'campaign_request',
      case new.status when 'approved' then 'Your campaign request was approved'
                      when 'rejected' then 'Your campaign request was not approved'
                      else 'Changes requested on your campaign request' end,
      array_remove(array[
        'Request: <b>' || public.html_escape(new.name) || '</b>',
        case when new.status = 'approved' and new.campaign_id is not null then 'Campaign number: <b>' || public.html_escape(new.campaign_id) || '</b>' end,
        case when nullif(trim(new.admin_note), '') is not null then 'Note from the office: ' || public.html_escape(new.admin_note) end], null),
      v_portal || case when new.status = 'approved' and new.campaign_id is not null then '#/campaigns/' || new.campaign_id else '#/requests' end,
      case when new.status = 'approved' then 'Open your campaign' else 'Open your requests' end,
      new.id, new.campaign_id);
  end loop;
  return new;
exception when others then return new;
end $$;

create or replace function public.on_team_request_decided() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r record; v_portal text := public.portal_url(new.org_id); v_who text := coalesce(new.person_name, new.email, new.phone);
begin
  if new.status is not distinct from old.status or new.status not in ('approved','rejected') then return new; end if;
  for r in select * from public.notice_requester(new.org_id, null, new.requested_by_email, 'requests') loop
    perform public.notify_person(new.org_id, r.email, r.phone, r.name, r.channel, 'team_request',
      case new.status when 'approved' then public.html_escape(v_who) || ' was added to your campaign' else 'Your team request was not approved' end,
      array_remove(array[
        'Campaign: ' || public.html_escape(public.campaign_label(new.org_id, new.campaign_id)),
        'Request: ' || public.html_escape(v_who) || ' as ' || replace(new.role, '_', ' '),
        case when nullif(trim(new.admin_note), '') is not null then 'Note from the office: ' || public.html_escape(new.admin_note) end], null),
      v_portal || '#/campaigns/' || new.campaign_id, 'Open the campaign', new.id, new.campaign_id);
  end loop;
  return new;
exception when others then return new;
end $$;

-- Someone added to a campaign's team, by the office directly or by an approved request, hears about it;
-- so does the primary, after the fact. A new primary hears too.
create or replace function public.on_campaign_team_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_added text[];
  m record;
  v_portal text := public.portal_url(new.org_id);
  v_label text := public.campaign_label(new.org_id, new.id);
begin
  if new.deleted_at is not null then return new; end if;
  v_added := array(select unnest(coalesce(new.sub_manager_ids, '{}')) except select unnest(coalesce(old.sub_manager_ids, '{}')));
  if new.manager_id is distinct from old.manager_id and new.manager_id is not null then v_added := v_added || new.manager_id; end if;
  for m in select x.id, x.email, x.phone, x.full_name from public.managers x
           where x.org_id = new.org_id and x.id = any(v_added) and x.deleted_at is null loop
    perform public.notify_person(new.org_id, m.email, m.phone, m.full_name, 'email', 'team_added',
      'You were added to ' || v_label,
      array['You''re now ' || case when m.id = new.manager_id then 'the primary fundraiser' else 'a fundraiser' end || ' on <b>' || public.html_escape(v_label) || '</b>.',
            'It shows on your dashboard when you sign in.'],
      v_portal || '#/campaigns/' || new.id, 'Open the campaign', new.id, new.id);
  end loop;
  -- The primary learns who the office added, unless they are the one added.
  if cardinality(v_added) > 0 and new.manager_id is not distinct from old.manager_id then
    for m in select x.email, x.phone, x.full_name from public.managers x where x.org_id = new.org_id and x.id = new.manager_id and x.deleted_at is null loop
      perform public.notify_person(new.org_id, m.email, m.phone, m.full_name, 'email', 'team_added',
        'Your campaign team changed',
        array[public.html_escape(array_to_string(array(select y.full_name from public.managers y where y.org_id = new.org_id and y.id = any(v_added) order by y.full_name), ', '))
                || case when cardinality(v_added) = 1 then ' was' else ' were' end || ' added to <b>' || public.html_escape(v_label) || '</b> by the office.'],
        v_portal || '#/campaigns/' || new.id, 'Open the campaign', new.id, new.id);
    end loop;
  end if;
  return new;
exception when others then return new;
end $$;

create or replace function public.on_payout_request_decided() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r record; v_portal text := public.portal_url(new.org_id);
begin
  if new.status is not distinct from old.status or new.status not in ('approved','rejected') then return new; end if;
  for r in select * from public.notice_requester(new.org_id, new.manager_id, new.requested_by, 'payouts') loop
    perform public.notify_person(new.org_id, r.email, r.phone, r.name, r.channel, 'payout_request',
      case new.status when 'approved' then 'Your payout request was approved' else 'Your payout request was not approved' end,
      array_remove(array[
        case when new.full_balance and new.status = 'approved'
             then 'The full balance' else '<b>' || public.money_text(new.amount) || '</b>' end
          || ' to ' || public.html_escape(new.recipient_name) || ' by ' || public.html_escape(new.method),
        'Campaign: ' || public.html_escape(public.campaign_label(new.org_id, new.campaign_id)),
        case when nullif(trim(new.decision_note), '') is not null then 'Note from the office: ' || public.html_escape(new.decision_note) end], null),
      v_portal || '#/payout-requests', 'Open your payout requests', new.id, new.campaign_id);
  end loop;
  return new;
exception when others then return new;
end $$;

-- A machine request is confirmed with its place in line; later changes to it are reported too.
create or replace function public.on_machine_booking_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  b record;
  v_portal text := public.portal_url(new.org_id);
  v_day text := to_char(new.booking_date, 'FMDay, FMMonth FMDD');
  v_subject text;
  v_line text;
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status and new.machine_id is not distinct from old.machine_id then return new; end if;
  select * into b from public.machine_booking_list x where x.org_id = new.org_id and x.id = new.id;
  if tg_op = 'INSERT' then
    v_subject := 'Machine request received for ' || v_day;
    v_line := 'You''re number <b>' || coalesce(b.queue_position::text, '?') || '</b> in line for that day. Requests are served first come, first served.';
  elsif new.status = 'confirmed' then
    v_subject := 'Machine confirmed for ' || v_day;
    v_line := case when b.machine_nickname is not null then 'Machine <b>' || b.machine_nickname || '</b> is yours that day.' else 'A machine is yours that day.' end;
  elsif new.status = 'waitlisted' then
    v_subject := 'Waitlisted for a machine on ' || v_day;
    v_line := 'All machines are taken that day. You''ll hear if one opens up.';
  elsif new.status = 'cancelled' and new.cancelled_by is distinct from (select m.email from public.managers m where m.org_id = new.org_id and m.id = new.manager_id) then
    v_subject := 'Machine request cancelled for ' || v_day;
    v_line := 'The office cancelled this request' || coalesce(': ' || public.html_escape(nullif(trim(new.cancel_reason), '')), '.');
  else
    return new;
  end if;
  for r in select * from public.notice_requester(new.org_id, new.manager_id, new.requested_by, 'bookings') loop
    perform public.notify_person(new.org_id, r.email, r.phone, r.name, r.channel, 'machine_booking', v_subject,
      array['Campaign: ' || public.html_escape(public.campaign_label(new.org_id, new.campaign_id)), v_line],
      v_portal || '#/machines', 'Open your bookings', new.id, new.campaign_id);
  end loop;
  return new;
exception when others then return new;
end $$;

create trigger notify_decision after update of status on public.campaign_requests
  for each row execute function public.on_campaign_request_decided();
create trigger notify_decision after update of status on public.campaign_team_requests
  for each row execute function public.on_team_request_decided();
create trigger notify_team after update of manager_id, sub_manager_ids on public.campaigns
  for each row execute function public.on_campaign_team_changed();
create trigger notify_decision after update of status on public.payout_requests
  for each row execute function public.on_payout_request_decided();
create trigger notify_booking after insert or update of status, machine_id on public.machine_bookings
  for each row execute function public.on_machine_booking_changed();

-- ---------------------------------------------------------------------------
-- Saving preferences
-- ---------------------------------------------------------------------------
create or replace function public.save_notification_preferences(
  p_phone text, p_donation_alerts text, p_donation_min numeric, p_donation_campaigns text[], p_donation_digest text,
  p_task_alerts text, p_payout_alerts text, p_weekly_digests boolean, p_channels jsonb
) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_admin boolean := public.is_admin(); v_bad text;
begin
  if auth.uid() is null or not public.is_active_user() then raise exception 'Sign in first'; end if;
  if nullif(trim(p_phone), '') is not null and public.normalize_phone(p_phone) is null then raise exception '"%" isn''t a valid phone number', p_phone; end if;
  if p_donation_alerts = 'over' and coalesce(p_donation_min, 0) <= 0 then raise exception 'Enter the amount donations must reach'; end if;
  select k into v_bad from jsonb_each_text(coalesce(p_channels, '{}')) e(k, v) where v not in ('email','sms','both') limit 1;
  if v_bad is not null then raise exception 'Choose email, text or both for %', v_bad; end if;
  insert into public.notification_preferences (org_id, user_id, phone, donation_alerts, donation_min, donation_campaigns, donation_digest,
                                               task_alerts, payout_alerts, weekly_digests, channels, updated_at)
  values (v_org, auth.uid(), public.normalize_phone(p_phone),
          case when v_admin then coalesce(p_donation_alerts, 'off') else 'off' end,
          case when p_donation_alerts = 'over' then p_donation_min end,
          case when v_admin and cardinality(p_donation_campaigns) > 0 then p_donation_campaigns end,
          case when v_admin then coalesce(p_donation_digest, 'off') else 'off' end,
          coalesce(p_task_alerts, 'both'), coalesce(p_payout_alerts, 'immediate'), coalesce(p_weekly_digests, true),
          coalesce(p_channels, '{}'), now())
  on conflict (org_id, user_id) do update set phone = excluded.phone, donation_alerts = excluded.donation_alerts,
    donation_min = excluded.donation_min, donation_campaigns = excluded.donation_campaigns, donation_digest = excluded.donation_digest,
    task_alerts = excluded.task_alerts, payout_alerts = excluded.payout_alerts, weekly_digests = excluded.weekly_digests,
    channels = excluded.channels, updated_at = excluded.updated_at;
end $$;

-- ---------------------------------------------------------------------------
-- Row-level security, logging, access and the minute job
-- ---------------------------------------------------------------------------
alter table public.notification_preferences enable row level security;
alter table public.donation_notices         enable row level security;
alter table public.task_sheet_seen          enable row level security;
alter table public.notification_state       enable row level security;
revoke all on public.notification_preferences, public.donation_notices, public.task_sheet_seen, public.notification_state from anon;
revoke insert, update, delete on public.notification_preferences, public.donation_notices, public.task_sheet_seen, public.notification_state from authenticated;
revoke select on public.donation_notices, public.task_sheet_seen, public.notification_state from authenticated;

create policy org_wall on public.notification_preferences as restrictive for all to authenticated
  using (org_id = (select public.current_org_id())) with check (org_id = (select public.current_org_id()));
create policy own_read on public.notification_preferences for select to authenticated using (user_id = (select auth.uid()));
create trigger log_row_change after insert or update or delete on public.notification_preferences
  for each row execute function public.log_row_change();

do $$
declare f text;
begin
  foreach f in array array[
    'org_zone(uuid)', 'portal_url(uuid)', 'notice_html(uuid, text, text[], text, text)',
    'notify_person(uuid, text, text, text, text, text, text, text[], text, text, text, text, text)',
    'notice_admins(uuid)', 'notice_team(uuid, text, text)', 'campaign_label(uuid, text)',
    'notify_donations(uuid)', 'as_org_admin(uuid)', 'notify_tasks(uuid)', 'notify_morning(uuid)', 'notify_weekly(uuid)',
    'notify_machine_digest(uuid)', 'run_notifications()', 'start_notifications()', 'notice_requester(uuid, text, text, text)',
    'on_campaign_request_decided()', 'on_team_request_decided()', 'on_campaign_team_changed()',
    'on_payout_request_decided()', 'on_machine_booking_changed()'
  ] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
  foreach f in array array['html_escape(text)', 'money_text(numeric)', 'notice_text(text, text[], text)', 'task_type_label(text)'] loop
    execute format('revoke execute on function public.%s from anon', f);
  end loop;
end $$;
revoke execute on function public.save_notification_preferences(text, text, numeric, text[], text, text, text, boolean, jsonb) from public, anon;
grant execute on function public.save_notification_preferences(text, text, numeric, text[], text, text, text, boolean, jsonb) to authenticated;

-- Alerts cover only what happens from now on.
select public.start_notifications();

select cron.schedule('notifications', '* * * * *', $$select public.run_notifications()$$);
