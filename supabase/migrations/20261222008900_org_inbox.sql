-- Per-organization email inbox (Shulim, approved 2026-11-19; plan docs/review/org-inbox-plan-2026-11-19.md).
-- SendGrid Inbound Parse receives mail for <random>@<inbox domain> and posts it to the email-inbound Edge Function,
-- which stores it here under the organization the address belongs to. Everything a trusted sender sends goes to
-- review; nothing posts by itself. The inbox domain is a platform setting (platform_config 'inbox_domain'), and the
-- parse secret lives only in the Edge Function's secrets: neither is in this file.

-- Platform settings (not per organization): only the platform owner changes them.
create table if not exists public.platform_config (
  key        text primary key,
  value      text,
  updated_at timestamptz not null default now()
);
alter table public.platform_config enable row level security;
revoke all on public.platform_config from anon, authenticated;

-- The "Manage inbox" permission, delegated to admins like the others.
alter table public.admin_delegations drop constraint if exists admin_delegations_permission_check;
alter table public.admin_delegations add constraint admin_delegations_permission_check check (permission = any (array[
  'manage_admins', 'grant_overrides', 'manage_api_keys', 'run_imports', 'change_default_bank', 'configure_fees',
  'reverse_imports', 'reopen_campaigns', 'manage_inbox']));
create or replace function public.can_manage_inbox() returns boolean
language sql stable security definer set search_path = '' as $$ select public.has_super_permission('manage_inbox') $$;
revoke execute on function public.can_manage_inbox() from public, anon;
grant execute on function public.can_manage_inbox() to authenticated;

-- An organization's inbox address. One active at a time; a replaced one keeps working for 14 days.
create table if not exists public.org_inboxes (
  org_id       uuid not null default public.current_org_id() references public.organizations(id),
  id           text not null default public.short_id(),
  local_part   text not null,
  status       text not null default 'active' check (status in ('active', 'replaced', 'off')),
  accept_until timestamptz,
  created_by   text default public.current_email(),
  created_at   timestamptz not null default now(),
  replaced_at  timestamptz,
  primary key (org_id, id)
);
create unique index if not exists org_inboxes_local on public.org_inboxes (lower(local_part));
create unique index if not exists org_inboxes_one_active on public.org_inboxes (org_id) where status = 'active';

-- Per-organization inbox settings.
create table if not exists public.inbox_settings (
  org_id     uuid primary key default public.current_org_id() references public.organizations(id),
  keep_years integer not null default 7 check (keep_years between 1 and 30),
  daily_cap  integer not null default 500 check (daily_cap between 10 and 10000),
  updated_at timestamptz not null default now()
);

-- Who may send reports: an exact address or a whole domain ("@ojcfund.org"), and what kind of report it sends.
create table if not exists public.inbox_trusted_senders (
  org_id      uuid not null default public.current_org_id() references public.organizations(id),
  id          text not null default public.short_id(),
  pattern     text not null check (pattern ~ '^(@[a-z0-9.-]+\.[a-z]{2,}|[^@\s]+@[a-z0-9.-]+\.[a-z]{2,})$'),
  report_type text not null default 'other' check (report_type in ('ojc_ach', 'ojc_submission', 'pledger_ach', 'pledger_batch',
                'bank_check_deposit', 'ab_charity', 'zelle', 'wire', 'sola_settlement', 'other')),
  label       text,
  created_by  text default public.current_email(),
  created_at  timestamptz not null default now(),
  primary key (org_id, id)
);
create unique index if not exists inbox_trusted_once on public.inbox_trusted_senders (org_id, lower(pattern));

-- Each message received, and its attachments (the files themselves are in the private "inbox" storage bucket).
create table if not exists public.inbound_emails (
  org_id         uuid not null references public.organizations(id),
  id             text not null default public.short_id(),
  inbox_id       text not null,
  message_id     text,
  from_address   text,
  from_name      text,
  subject        text,
  sent_at        timestamptz,
  received_at    timestamptz not null default now(),
  envelope_from  text,
  size_bytes     integer,
  spam_score     numeric,
  spf            text,
  dkim           text,
  authentic      boolean not null default false,
  auth_reason    text,
  trusted_sender_id text,
  report_type    text,
  body_text      text,                       -- plain text, card-like numbers masked to their last 4
  raw_path       text,                       -- storage path of the original .eml
  status         text not null default 'new' check (status in ('new', 'to_review', 'reviewed', 'ignored', 'not_trusted', 'possible_duplicate')),
  duplicate_of   text,
  forwarding_confirmation boolean not null default false,
  reviewed_by    text,
  reviewed_at    timestamptz,
  review_note    text,
  complete       boolean not null default false,   -- files stored and checks done
  primary key (org_id, id)
);
create index if not exists inbound_emails_recent on public.inbound_emails (org_id, received_at desc);
create index if not exists inbound_emails_msgid on public.inbound_emails (org_id, message_id) where message_id is not null;

create table if not exists public.inbound_attachments (
  org_id       uuid not null references public.organizations(id),
  id           text not null default public.short_id(),
  email_id     text not null,
  filename     text,
  mime         text,
  size_bytes   integer,
  sha256       text,
  storage_path text not null,
  primary key (org_id, id)
);
create index if not exists inbound_attachments_email on public.inbound_attachments (org_id, email_id);

-- Row-level security: only this organization's inbox managers; fundraisers never see the inbox.
do $$
declare t text;
begin
  foreach t in array array['org_inboxes', 'inbox_settings', 'inbox_trusted_senders', 'inbound_emails', 'inbound_attachments'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('drop policy if exists org_wall on public.%I', t);
    execute format('create policy org_wall on public.%I as restrictive for all to authenticated using (org_id = (select public.current_org_id())) with check (org_id = (select public.current_org_id()))', t);
    execute format('drop policy if exists inbox_managers on public.%I', t);
    execute format('create policy inbox_managers on public.%I for select to authenticated using ((select public.can_manage_inbox()))', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;
-- Trusted senders and settings are edited directly by inbox managers; addresses and emails only through the functions below.
grant insert, update, delete on public.inbox_trusted_senders to authenticated;
drop policy if exists inbox_managers_write on public.inbox_trusted_senders;
create policy inbox_managers_write on public.inbox_trusted_senders for all to authenticated
  using ((select public.can_manage_inbox())) with check ((select public.can_manage_inbox()));
grant insert, update on public.inbox_settings to authenticated;
drop policy if exists inbox_managers_write on public.inbox_settings;
create policy inbox_managers_write on public.inbox_settings for all to authenticated
  using ((select public.can_manage_inbox())) with check ((select public.can_manage_inbox()));

-- The private bucket for raw emails and attachments, one folder per organization: inbox/<org_id>/<email_id>/...
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public) values ('inbox', 'inbox', false) on conflict (id) do nothing;
    drop policy if exists inbox_files_read on storage.objects;
    create policy inbox_files_read on storage.objects for select to authenticated
      using (bucket_id = 'inbox' and (storage.foldername(name))[1] = (select public.current_org_id())::text and (select public.can_manage_inbox()));
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- For the Settings screen
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.inbox_status()
returns table (address text, status text, created_at timestamptz, created_by text, domain_set boolean, keep_years integer,
               old_address text, old_until timestamptz, to_review bigint)
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_domain text;
begin
  if not public.can_manage_inbox() then raise exception 'Only an admin who can manage the inbox can see this'; end if;
  select value into v_domain from public.platform_config where key = 'inbox_domain';
  return query
    select (select i.local_part || '@' || v_domain from public.org_inboxes i where i.org_id = v_org and i.status = 'active' and v_domain is not null),
           coalesce((select i.status from public.org_inboxes i where i.org_id = v_org and i.status = 'active'), 'none'),
           (select i.created_at from public.org_inboxes i where i.org_id = v_org and i.status = 'active'),
           (select i.created_by from public.org_inboxes i where i.org_id = v_org and i.status = 'active'),
           v_domain is not null,
           coalesce((select s.keep_years from public.inbox_settings s where s.org_id = v_org), 7),
           (select i.local_part || '@' || v_domain from public.org_inboxes i where i.org_id = v_org and i.status = 'replaced'
              and i.accept_until > now() order by i.replaced_at desc limit 1),
           (select i.accept_until from public.org_inboxes i where i.org_id = v_org and i.status = 'replaced'
              and i.accept_until > now() order by i.replaced_at desc limit 1),
           (select count(*) from public.inbound_emails e where e.org_id = v_org and e.status in ('to_review', 'possible_duplicate'));
end $$;
revoke execute on function public.inbox_status() from public, anon;
grant execute on function public.inbox_status() to authenticated;

-- Create (or replace) this organization's address: 20 random letters and digits from a strong random source.
create or replace function public.inbox_new_address() returns text
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_local text; v_domain text;
begin
  if not public.can_manage_inbox() then raise exception 'Only an admin who can manage the inbox can do this'; end if;
  select value into v_domain from public.platform_config where key = 'inbox_domain';
  if v_domain is null then raise exception 'The inbox isn''t switched on for the platform yet. Ask the Platform Owner.'; end if;
  v_local := (select string_agg(substr('abcdefghjkmnpqrstuvwxyz23456789', 1 + (get_byte(b, i) % 31), 1), '')
              from (select extensions.gen_random_bytes(20) b) x, generate_series(0, 19) i);
  update public.org_inboxes set status = 'replaced', replaced_at = now(), accept_until = now() + interval '14 days'
   where org_id = v_org and status = 'active';
  insert into public.org_inboxes (org_id, local_part) values (v_org, v_local);
  perform public.write_activity(v_org, 'inbox_address_created', 'org_inboxes', v_local, null, '{}'::jsonb);
  return v_local || '@' || v_domain;
end $$;
revoke execute on function public.inbox_new_address() from public, anon;
grant execute on function public.inbox_new_address() to authenticated;

-- Turn the inbox off: the address (and any old one still in its 14 days) stops accepting at once.
create or replace function public.inbox_turn_off() returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  if not public.can_manage_inbox() then raise exception 'Only an admin who can manage the inbox can do this'; end if;
  update public.org_inboxes set status = 'off', accept_until = null, replaced_at = coalesce(replaced_at, now())
   where org_id = v_org and status in ('active', 'replaced');
  perform public.write_activity(v_org, 'inbox_turned_off', 'org_inboxes', null, null, '{}'::jsonb);
end $$;
revoke execute on function public.inbox_turn_off() from public, anon;
grant execute on function public.inbox_turn_off() to authenticated;

-- Close a review item: reviewed (done), ignored, or "not a duplicate" (back to review). Nothing in the books changes.
create or replace function public.inbox_review(p_email text, p_action text, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); e public.inbound_emails;
begin
  if not public.can_manage_inbox() then raise exception 'Only an admin who can manage the inbox can do this'; end if;
  select * into e from public.inbound_emails where org_id = v_org and id = p_email for update;
  if e.id is null then raise exception 'Email not found'; end if;
  if p_action not in ('reviewed', 'ignored', 'not_duplicate', 'reopen') then raise exception 'Unknown action'; end if;
  update public.inbound_emails
     set status = case p_action when 'not_duplicate' then 'to_review' when 'reopen' then 'to_review' else p_action end,
         duplicate_of = case when p_action = 'not_duplicate' then null else duplicate_of end,
         reviewed_by = case when p_action in ('reviewed', 'ignored') then public.current_email() end,
         reviewed_at = case when p_action in ('reviewed', 'ignored') then now() end,
         review_note = coalesce(nullif(trim(p_note), ''), review_note)
   where org_id = v_org and id = p_email;
  perform public.inbox_task_sync(v_org, p_email);
end $$;
revoke execute on function public.inbox_review(text, text, text) from public, anon;
grant execute on function public.inbox_review(text, text, text) to authenticated;

-- Trust the sender of a message (exact address), and send that message to review.
create or replace function public.inbox_trust_sender(p_email text, p_report_type text default 'other') returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); e public.inbound_emails; v_id text;
begin
  if not public.can_manage_inbox() then raise exception 'Only an admin who can manage the inbox can do this'; end if;
  select * into e from public.inbound_emails where org_id = v_org and id = p_email for update;
  if e.id is null or e.from_address is null then raise exception 'Email not found'; end if;
  insert into public.inbox_trusted_senders (org_id, pattern, report_type, label)
  values (v_org, lower(e.from_address), coalesce(p_report_type, 'other'), 'Added from the inbox')
  on conflict (org_id, lower(pattern)) do update set report_type = excluded.report_type
  returning id into v_id;
  update public.inbound_emails set trusted_sender_id = v_id, report_type = coalesce(p_report_type, 'other'),
         status = case when status = 'not_trusted' then 'to_review' else status end
   where org_id = v_org and id = p_email;
  perform public.inbox_task_sync(v_org, p_email);
end $$;
revoke execute on function public.inbox_trust_sender(text, text) from public, anon;
grant execute on function public.inbox_trust_sender(text, text) to authenticated;

-- One Task Sheet item per email waiting for review (to review or possible duplicate); resolved otherwise.
create or replace function public.inbox_task_sync(p_org uuid, p_email text) returns void
language plpgsql security definer set search_path = '' as $$
declare e public.inbound_emails;
begin
  select * into e from public.inbound_emails where org_id = p_org and id = p_email;
  if e.id is null then return; end if;
  if e.status in ('to_review', 'possible_duplicate') and e.complete then
    insert into public.task_items (org_id, task_key, task_type, record_id, summary)
    values (p_org, 'inbox_review:' || e.id, 'inbox_review', e.id,
            left(case when e.status = 'possible_duplicate' then 'Possible duplicate: ' else 'Inbox: ' end
                 || coalesce(nullif(e.subject, ''), '(no subject)') || ' · from ' || coalesce(e.from_address, 'unknown'), 300))
    on conflict (org_id, task_key) do update set summary = excluded.summary, resolved_at = null;
  else
    update public.task_items set resolved_at = now() where org_id = p_org and task_key = 'inbox_review:' || e.id and resolved_at is null;
  end if;
end $$;
revoke execute on function public.inbox_task_sync(uuid, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- For the email-inbound Edge Function (secret key only)
-- ---------------------------------------------------------------------------------------------------------------
-- Step 1: an address and a message's headers. Says which organization (or none), and gives the email row to fill.
-- A retry of a message whose files didn't finish storing gets the same row back; a second complete copy is kept and
-- marked as a possible duplicate (never skipped).
create or replace function public.inbox_receive(p_local text, p_meta jsonb)
returns table (org_id uuid, email_id text, retry boolean, outcome text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare i public.org_inboxes; v_cap integer; v_today integer; v_msgid text := nullif(trim(p_meta ->> 'message_id'), '');
        v_prev public.inbound_emails; v_id text;
begin
  select * into i from public.org_inboxes x where lower(x.local_part) = lower(trim(p_local))
     and (x.status = 'active' or (x.status = 'replaced' and x.accept_until > now()));
  if i.id is null then return query select null::uuid, null::text, false, 'unknown_address'; return; end if;
  select coalesce((select s.daily_cap from public.inbox_settings s where s.org_id = i.org_id), 500) into v_cap;
  select count(*) into v_today from public.inbound_emails e where e.org_id = i.org_id and e.received_at > now() - interval '1 day';
  if v_today >= v_cap then
    insert into public.task_items (org_id, task_key, task_type, summary)
    values (i.org_id, 'inbox_cap:' || to_char(now(), 'YYYY-MM-DD'), 'inbox_cap', format('The inbox reached its limit of %s messages in a day; later ones weren''t kept', v_cap))
    on conflict (org_id, task_key) do nothing;
    return query select i.org_id, null::text, false, 'over_cap'; return;
  end if;
  if v_msgid is not null then
    select * into v_prev from public.inbound_emails e where e.org_id = i.org_id and e.message_id = v_msgid order by e.received_at limit 1;
    if v_prev.id is not null and not v_prev.complete then
      return query select i.org_id, v_prev.id, true, 'retry'; return;
    end if;
  end if;
  insert into public.inbound_emails (org_id, inbox_id, message_id, from_address, from_name, subject, sent_at, envelope_from, size_bytes,
                                     spam_score, spf, dkim, duplicate_of)
  values (i.org_id, i.id, v_msgid, lower(nullif(trim(p_meta ->> 'from_address'), '')), nullif(trim(p_meta ->> 'from_name'), ''),
          left(p_meta ->> 'subject', 500), (p_meta ->> 'sent_at')::timestamptz, lower(nullif(trim(p_meta ->> 'envelope_from'), '')),
          (p_meta ->> 'size_bytes')::integer, (p_meta ->> 'spam_score')::numeric, left(p_meta ->> 'spf', 200), left(p_meta ->> 'dkim', 2000),
          v_prev.id)
  returning id into v_id;
  return query select i.org_id, v_id, false, case when v_prev.id is not null then 'possible_duplicate' else 'new' end;
end $$;
revoke execute on function public.inbox_receive(text, jsonb) from public, anon, authenticated;

-- Step 2: files stored and the authenticity worked out. Decides trusted / not trusted and sends it to review.
create or replace function public.inbox_finish(p_org uuid, p_email text, p_raw_path text, p_body_text text, p_authentic boolean,
                                               p_auth_reason text, p_attachments jsonb, p_forwarding_confirmation boolean)
returns text language plpgsql security definer set search_path = '' as $$
declare e public.inbound_emails; t public.inbox_trusted_senders; v_status text; a jsonb;
begin
  select * into e from public.inbound_emails where org_id = p_org and id = p_email for update;
  if e.id is null then raise exception 'No such email'; end if;
  -- The sender's exact address first, then their domain.
  select * into t from public.inbox_trusted_senders s
   where s.org_id = p_org and (lower(s.pattern) = e.from_address or (s.pattern like '@%' and e.from_address like '%' || lower(s.pattern)))
   order by (s.pattern like '@%'), s.created_at limit 1;
  v_status := case when e.duplicate_of is not null then 'possible_duplicate'
                   when p_forwarding_confirmation then 'to_review'          -- the admin needs the code, from any sender
                   when t.id is not null and p_authentic then 'to_review'
                   else 'not_trusted' end;
  delete from public.inbound_attachments where org_id = p_org and email_id = p_email;   -- a retry rewrites them
  for a in select * from jsonb_array_elements(coalesce(p_attachments, '[]'::jsonb)) loop
    insert into public.inbound_attachments (org_id, email_id, filename, mime, size_bytes, sha256, storage_path)
    values (p_org, p_email, left(a ->> 'filename', 300), left(a ->> 'mime', 200), (a ->> 'size_bytes')::integer, a ->> 'sha256', a ->> 'storage_path');
  end loop;
  update public.inbound_emails
     set raw_path = p_raw_path, body_text = left(p_body_text, 200000), authentic = coalesce(p_authentic, false),
         auth_reason = left(p_auth_reason, 500), trusted_sender_id = t.id, report_type = t.report_type,
         forwarding_confirmation = coalesce(p_forwarding_confirmation, false), status = v_status, complete = true
   where org_id = p_org and id = p_email;
  perform public.inbox_task_sync(p_org, p_email);
  return v_status;
end $$;
revoke execute on function public.inbox_finish(uuid, text, text, text, boolean, text, jsonb, boolean) from public, anon, authenticated;

-- What the retention clean-up may remove: raw files older than each organization's "keep for" years.
create or replace function public.inbox_expired_files(p_limit integer default 200)
returns table (org_id uuid, email_id text, path text)
language sql stable security definer set search_path = '' as $$
  select e.org_id, e.id, p.path
  from public.inbound_emails e
  left join public.inbox_settings s on s.org_id = e.org_id
  cross join lateral (select e.raw_path as path union all select a.storage_path from public.inbound_attachments a where a.org_id = e.org_id and a.email_id = e.id) p
  where e.received_at < now() - make_interval(years => coalesce(s.keep_years, 7)) and e.raw_path is not null and p.path is not null
  limit greatest(least(p_limit, 1000), 1)
$$;
revoke execute on function public.inbox_expired_files(integer) from public, anon, authenticated;

create or replace function public.inbox_files_removed(p_org uuid, p_email text) returns void
language sql security definer set search_path = '' as $$
  update public.inbound_emails set raw_path = null where org_id = p_org and id = p_email;
  delete from public.inbound_attachments where org_id = p_org and email_id = p_email;
$$;
revoke execute on function public.inbox_files_removed(uuid, text) from public, anon, authenticated;

-- Once a day: ask email-inbound to remove expired files (it holds the storage access). Only when some have expired.
create or replace function public.kick_inbox_retention() returns void
language plpgsql security definer set search_path = '' as $$
declare v_url text; v_token text;
begin
  if not exists (select 1 from public.inbox_expired_files(1)) then return; end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into v_token from vault.decrypted_secrets where name = 'messaging_cron_token';
  if v_url is null or v_token is null then return; end if;
  perform net.http_post(url := rtrim(v_url, '/') || '/functions/v1/email-inbound/retention',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-token', v_token), body := '{}'::jsonb);
end $$;
revoke execute on function public.kick_inbox_retention() from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    perform cron.schedule('inbox_retention', '15 8 * * *', $c$select public.kick_inbox_retention()$c$);
  end if;
end $$;

-- The inbox domain, for the email-inbound Edge Function (secret key only; the app gets it through inbox_status).
create or replace function public.inbox_domain() returns text
language sql stable security definer set search_path = '' as $$ select value from public.platform_config where key = 'inbox_domain' $$;
revoke execute on function public.inbox_domain() from public, anon, authenticated;
