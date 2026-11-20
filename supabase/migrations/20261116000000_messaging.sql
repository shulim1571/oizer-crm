-- Phase 7 part 1: the sending engine. Every email and text the system sends is a row in messages. The
-- send-messages Edge Function picks queued rows up and hands them to SendGrid or Twilio, and the
-- message-events function records what the providers report back (delivered, bounced, STOP). A
-- failure becomes a Delivery Failed item on the Task Sheet; there is no automatic retry. Until an
-- organization switches sending on, messages go only to its test addresses and the rest are held.
-- Receipts and statements can now be sent by email or text; a text carries a private link to the page.

create extension if not exists pg_net;

-- ---------------------------------------------------------------------------
-- Settings: who messages come from, and whether they reach real people yet
-- ---------------------------------------------------------------------------
create table public.messaging_settings (
  org_id           uuid primary key default public.current_org_id() references public.organizations(id),
  from_name        text,
  from_email       text,
  reply_to         text,
  sms_from         text,
  live             boolean not null default false,
  test_recipients  text[] not null default '{}',
  updated_by       text default public.current_email(),
  updated_at       timestamptz not null default now()
);

-- The platform's authenticated sending domain. An organization can use its own once that domain is verified too.
create or replace function public.default_from_email() returns text
language sql immutable as $$ select 'notifications@mail.trubase.org' $$;

-- Ten US digits become +1 and eleven starting with 1 gain the +; anything with a + is kept as dialed.
create or replace function public.normalize_phone(p text) returns text
language sql immutable as $$
  select case
    when p is null then null
    when trim(p) like '+%' then case when length(regexp_replace(p, '\D', '', 'g')) between 8 and 15 then '+' || regexp_replace(p, '\D', '', 'g') end
    when length(regexp_replace(p, '\D', '', 'g')) = 10 then '+1' || regexp_replace(p, '\D', '', 'g')
    when length(regexp_replace(p, '\D', '', 'g')) = 11 and regexp_replace(p, '\D', '', 'g') like '1%' then '+' || regexp_replace(p, '\D', '', 'g')
  end
$$;

create or replace function public.normalize_address(p_channel text, p text) returns text
language sql immutable as $$
  select case p_channel
    when 'sms' then public.normalize_phone(p)
    else case when lower(trim(p)) ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then lower(trim(p)) end
  end
$$;

-- ---------------------------------------------------------------------------
-- Messages, opt-outs and shared pages
-- ---------------------------------------------------------------------------
create table public.messages (
  org_id        uuid not null default public.current_org_id() references public.organizations(id),
  id            uuid not null default gen_random_uuid(),
  channel       text not null check (channel in ('email','sms')),
  to_address    text not null,
  to_name       text,
  subject       text,
  body          text not null,
  html          text,
  kind          text not null default 'message',
  record_id     text,
  donor_id      text,
  campaign_id   text,
  status        text not null default 'queued'
                check (status in ('queued','sending','sent','delivered','failed','opted_out','held')),
  error         text,
  provider_id   text,
  send_after    timestamptz not null default now(),
  attempts      integer not null default 0,
  resent_as     uuid,
  created_by    text default public.current_email(),
  created_at    timestamptz not null default now(),
  sent_at       timestamptz,
  delivered_at  timestamptz,
  opened_at     timestamptz,
  clicked_at    timestamptz,
  failed_at     timestamptz,
  primary key (org_id, id)
);
create index messages_queue on public.messages (send_after) where status = 'queued';
create index messages_provider on public.messages (provider_id) where provider_id is not null;
create index messages_recent on public.messages (org_id, created_at desc);
create index messages_record on public.messages (org_id, record_id) where record_id is not null;

-- Who replied STOP (texts) and so must not get texts from this organization until they reply START.
create table public.message_opt_outs (
  org_id      uuid not null references public.organizations(id),
  channel     text not null check (channel in ('email','sms')),
  address     text not null,
  source      text not null default 'reply',
  created_at  timestamptz not null default now(),
  primary key (org_id, channel, address)
);

-- A page someone can open from a link in a text, such as a receipt. The token is the only key.
create table public.shared_documents (
  token       text primary key default encode(extensions.gen_random_bytes(18), 'hex'),
  org_id      uuid not null default public.current_org_id() references public.organizations(id),
  kind        text not null,
  record_id   text,
  title       text not null,
  html        text not null,
  created_by  text default public.current_email(),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '1 year'
);

-- Whether the providers' keys are in place, as the sender last saw them. Platform-wide.
create table public.messaging_providers (
  id          integer primary key default 1 check (id = 1),
  email_ready boolean not null default false,
  sms_ready   boolean not null default false,
  checked_at  timestamptz
);
insert into public.messaging_providers default values;

-- The sender is called with a token only the database knows, so nobody else can trigger it.
do $$
begin
  if not exists (select 1 from vault.decrypted_secrets where name = 'messaging_cron_token') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(24), 'hex'), 'messaging_cron_token', 'Lets the database call the send-messages function');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Waking the sender
-- ---------------------------------------------------------------------------
-- Calls the send-messages function right away. The project's URL is a Vault entry named project_url;
-- without it (a local test database) nothing is called and the minute job is the only sender.
create or replace function public.kick_sender() returns void
language plpgsql security definer set search_path = '' as $$
declare v_url text; v_token text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into v_token from vault.decrypted_secrets where name = 'messaging_cron_token';
  if v_url is null or v_token is null then return; end if;
  perform net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/send-messages',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-token', v_token),
    body := '{}'::jsonb);
end $$;

create or replace function public.kick_sender_if_due() returns void
language plpgsql security definer set search_path = '' as $$
begin
  -- A send that never finished is reported, not retried, so nobody gets it twice.
  update public.messages set status = 'failed', failed_at = now(), error = 'Sending did not finish. Check with the recipient before resending'
  where status = 'sending' and sent_at is null and created_at < now() - interval '15 minutes';
  if exists (select 1 from public.messages where status = 'queued' and send_after <= now()) then
    perform public.kick_sender();
  end if;
end $$;

create or replace function public.check_cron_token(p_token text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from vault.decrypted_secrets where name = 'messaging_cron_token' and decrypted_secret = p_token and p_token <> '')
$$;

-- ---------------------------------------------------------------------------
-- Queueing
-- ---------------------------------------------------------------------------
-- The one way a message is created. Checks the address, honors opt-outs and holds anything outside
-- the test list while the organization isn't live. Returns the message id.
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
  if v_status = 'queued' and coalesce(p_send_after, now()) <= now() then perform public.kick_sender(); end if;
  return v_id;
end $$;

-- Admin: a test message, to check the setup.
create or replace function public.send_test_message(p_channel text, p_to text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_name text;
begin
  perform public.require_admin();
  select name into v_name from public.organizations where id = v_org;
  return public.queue_message(v_org, p_channel, p_to, null,
    'Test message from ' || v_name,
    'This is a test message from ' || v_name || '. If you got it, ' || case p_channel when 'sms' then 'texts' else 'email' end || ' from the CRM work.',
    null, 'test');
end $$;

-- Admin: sends a receipt or statement page. Email carries the page itself; a text carries a private
-- link to it. p_link_base is the portal's address, so the link opens where the office works.
create or replace function public.send_document(
  p_kind text, p_record_id text, p_donor text, p_title text, p_html text,
  p_email text, p_phone text, p_link_base text, p_campaign text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  v_org_name text;
  v_name text;
  v_token text;
  v_label text := case p_kind when 'receipt' then 'receipt' when 'statement' then 'giving statement' else 'document' end;
  v_out jsonb := '{}';
begin
  perform public.require_admin();
  if p_kind not in ('receipt','statement') then raise exception 'Unknown document'; end if;
  if nullif(trim(p_email), '') is null and nullif(trim(p_phone), '') is null then raise exception 'Enter an email address or a phone number'; end if;
  select name into v_org_name from public.organizations where id = v_org;
  select display_name into v_name from public.donors where org_id = v_org and id = p_donor;
  if nullif(trim(p_email), '') is not null then
    v_out := v_out || jsonb_build_object('email', public.queue_message(v_org, 'email', p_email, v_name,
      'Your ' || v_label || ' from ' || v_org_name || ': ' || p_title,
      'Your ' || v_label || ' from ' || v_org_name || ' is attached below. ' || p_title, p_html,
      p_kind, p_record_id, p_donor, p_campaign));
  end if;
  if nullif(trim(p_phone), '') is not null then
    insert into public.shared_documents (org_id, kind, record_id, title, html)
    values (v_org, p_kind, p_record_id, p_title, p_html) returning token into v_token;
    v_out := v_out || jsonb_build_object('sms', public.queue_message(v_org, 'sms', p_phone, v_name, null,
      v_org_name || ': your ' || v_label || ' ' || p_title || ' is here: ' || rtrim(p_link_base, '/') || '/#/d/' || v_token,
      null, p_kind, p_record_id, p_donor, p_campaign));
  end if;
  perform public.write_activity(v_org, 'send_' || p_kind, p_kind || 's', p_record_id, p_campaign,
    jsonb_build_object('title', p_title, 'email', nullif(trim(p_email), ''), 'phone', nullif(trim(p_phone), '')));
  return v_out;
end $$;

-- Anyone with the link: the page behind it.
create or replace function public.shared_document(p_token text) returns table (title text, html text)
language sql stable security definer set search_path = '' as $$
  select d.title, d.html from public.shared_documents d where d.token = p_token and d.expires_at > now()
$$;

-- Admin: sends a failed or held message again, to the same or a corrected address.
create or replace function public.resend_message(p_id uuid, p_to text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare m public.messages; v_new uuid;
begin
  perform public.require_admin();
  select * into m from public.messages where org_id = public.current_org_id() and id = p_id;
  if m.id is null then raise exception 'Message not found'; end if;
  if m.status not in ('failed','held','opted_out') then raise exception 'Only a failed or held message can be sent again'; end if;
  v_new := public.queue_message(m.org_id, m.channel, coalesce(nullif(trim(p_to), ''), m.to_address), m.to_name, m.subject, m.body, m.html,
                                m.kind, m.record_id, m.donor_id, m.campaign_id);
  update public.messages set resent_as = v_new where org_id = m.org_id and id = m.id;
  return v_new;
end $$;

-- Admin: saves the sender details and test mode.
create or replace function public.save_messaging_settings(
  p_from_name text, p_from_email text, p_reply_to text, p_sms_from text, p_live boolean, p_test_recipients text[]
) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_bad text;
begin
  perform public.require_admin();
  if nullif(trim(p_from_email), '') is not null and public.normalize_address('email', p_from_email) is null then
    raise exception '"%" isn''t a valid email address', p_from_email;
  end if;
  if nullif(trim(p_reply_to), '') is not null and public.normalize_address('email', p_reply_to) is null then
    raise exception '"%" isn''t a valid email address', p_reply_to;
  end if;
  if nullif(trim(p_sms_from), '') is not null and public.normalize_phone(p_sms_from) is null then
    raise exception '"%" isn''t a valid phone number', p_sms_from;
  end if;
  select t into v_bad from unnest(coalesce(p_test_recipients, '{}')) t
  where nullif(trim(t), '') is not null and public.normalize_address('email', t) is null and public.normalize_phone(t) is null limit 1;
  if v_bad is not null then raise exception 'Test list: "%" isn''t an email address or phone number', v_bad; end if;
  insert into public.messaging_settings (org_id, from_name, from_email, reply_to, sms_from, live, test_recipients, updated_by, updated_at)
  values (v_org, nullif(trim(p_from_name), ''), public.normalize_address('email', p_from_email), public.normalize_address('email', p_reply_to),
          public.normalize_phone(p_sms_from), coalesce(p_live, false),
          array(select trim(t) from unnest(coalesce(p_test_recipients, '{}')) t where nullif(trim(t), '') is not null),
          public.current_email(), now())
  on conflict (org_id) do update set from_name = excluded.from_name, from_email = excluded.from_email, reply_to = excluded.reply_to,
    sms_from = excluded.sms_from, live = excluded.live, test_recipients = excluded.test_recipients,
    updated_by = excluded.updated_by, updated_at = excluded.updated_at;
end $$;

-- Admin: lets a number get texts again, such as after the person asks by phone. Replying START does this too.
create or replace function public.remove_opt_out(p_channel text, p_address text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_admin();
  delete from public.message_opt_outs where org_id = public.current_org_id() and channel = p_channel and address = p_address;
end $$;

-- ---------------------------------------------------------------------------
-- For the Edge Functions (service role only)
-- ---------------------------------------------------------------------------
-- Takes up to p_limit due messages and marks them sending, with each organization's sender details.
create or replace function public.claim_messages(p_limit integer default 50)
returns table (org_id uuid, id uuid, channel text, to_address text, to_name text, subject text, body text, html text, kind text,
               from_name text, from_email text, reply_to text, sms_from text)
language sql security definer set search_path = '' as $$
  with due as (
    select m.org_id, m.id from public.messages m
    where m.status = 'queued' and m.send_after <= now()
    order by m.send_after, m.created_at
    limit p_limit
    for update skip locked
  ), taken as (
    update public.messages m set status = 'sending', attempts = m.attempts + 1
    from due where m.org_id = due.org_id and m.id = due.id
    returning m.*
  )
  select t.org_id, t.id, t.channel, t.to_address, t.to_name, t.subject, t.body, t.html, t.kind,
         coalesce(s.from_name, o.name), coalesce(s.from_email, public.default_from_email()), coalesce(s.reply_to, lower(o.email)), s.sms_from
  from taken t
  join public.organizations o on o.id = t.org_id
  left join public.messaging_settings s on s.org_id = t.org_id
$$;

-- The provider's answer to the hand-off.
create or replace function public.message_sent(p_org uuid, p_id uuid, p_ok boolean, p_provider_id text, p_error text, p_opted_out boolean default false)
returns void
language plpgsql security definer set search_path = '' as $$
declare m public.messages;
begin
  update public.messages set
    status = case when p_ok then 'sent' when p_opted_out then 'opted_out' else 'failed' end,
    provider_id = coalesce(p_provider_id, provider_id),
    sent_at = case when p_ok then now() end,
    failed_at = case when p_ok or p_opted_out then null else now() end,
    error = case when p_ok then null else p_error end
  where org_id = p_org and id = p_id
  returning * into m;
  if p_opted_out and m.id is not null then
    insert into public.message_opt_outs (org_id, channel, address, source) values (m.org_id, m.channel, m.to_address, 'provider')
    on conflict do nothing;
  end if;
end $$;

-- Delivery reports. Found by our id when the provider echoes it, otherwise by the provider's id.
-- A later report never moves a message backwards: delivered stays delivered.
create or replace function public.message_event(p_org uuid, p_id uuid, p_provider_id text, p_event text, p_reason text, p_at timestamptz)
returns void
language plpgsql security definer set search_path = '' as $$
declare m public.messages; v_at timestamptz := coalesce(p_at, now());
begin
  if p_id is not null then
    select * into m from public.messages where org_id = p_org and id = p_id;
  end if;
  if m.id is null and p_provider_id is not null then
    select * into m from public.messages where provider_id = p_provider_id or (channel = 'email' and p_provider_id like provider_id || '.%') limit 1;
  end if;
  if m.id is null then return; end if;
  case
    when p_event = 'delivered' then
      update public.messages set status = 'delivered', delivered_at = v_at, failed_at = null, error = null
      where org_id = m.org_id and id = m.id;
    when p_event in ('bounce','bounced','dropped','blocked','failed','undelivered') then
      update public.messages set status = 'failed', failed_at = v_at,
             error = coalesce(nullif(trim(p_reason), ''), initcap(p_event))
      where org_id = m.org_id and id = m.id and status <> 'delivered';
    when p_event = 'open' then
      update public.messages set opened_at = coalesce(opened_at, v_at) where org_id = m.org_id and id = m.id;
    when p_event = 'click' then
      update public.messages set clicked_at = coalesce(clicked_at, v_at), opened_at = coalesce(opened_at, v_at) where org_id = m.org_id and id = m.id;
    when p_event = 'sent' then
      update public.messages set status = 'sent', sent_at = coalesce(sent_at, v_at) where org_id = m.org_id and id = m.id and status in ('sending','queued');
    else null;
  end case;
end $$;

-- A text to an organization's number. STOP and the other carrier keywords opt the sender out; START opts back in.
create or replace function public.sms_inbound(p_to text, p_from text, p_body text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_word text := upper(trim(coalesce(p_body, ''))); v_from text := public.normalize_phone(p_from);
begin
  select org_id into v_org from public.messaging_settings where sms_from = public.normalize_phone(p_to) limit 1;
  if v_org is null or v_from is null then return; end if;
  if v_word in ('STOP','STOPALL','UNSUBSCRIBE','CANCEL','END','QUIT','REVOKE','OPTOUT') then
    insert into public.message_opt_outs (org_id, channel, address) values (v_org, 'sms', v_from) on conflict do nothing;
  elsif v_word in ('START','UNSTOP','YES') then
    delete from public.message_opt_outs where org_id = v_org and channel = 'sms' and address = v_from;
  end if;
end $$;

create or replace function public.messaging_ready(p_email boolean, p_sms boolean) returns void
language sql security definer set search_path = '' as $$
  update public.messaging_providers set email_ready = p_email, sms_ready = p_sms, checked_at = now() where id = 1
$$;

-- ---------------------------------------------------------------------------
-- The Task Sheet gains Delivery Failed: one item per failed message
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
  union all
  select o.id, 'receipt_text_missing', 'receipt_text_missing', o.id::text, null, null, null, o.created_at,
         'Set the Hebrew and English receipt text in Settings → Receipt Text. Until then receipts leave those sections out'
  from public.organizations o
  where o.id = public.current_org_id()
    and not exists (select 1 from public.receipt_templates t where t.org_id = o.id and t.level = 'default'
                    and (t.hebrew_text is not null or t.english_text is not null))
  union all
  select r.org_id, 'receipt_reissue:' || r.id, 'receipt_reissue', r.id, r.campaign_id, m.full_name, r.amount, r.voided_at,
         r.receipt_number || ' for ' || coalesce(r.donor_name, 'a donor') || ' was voided because the donation changed'
  from public.receipts r
  left join public.campaigns c on c.org_id = r.org_id and c.id = r.campaign_id
  left join public.managers m on m.org_id = c.org_id and m.id = c.manager_id
  where r.needs_reissue and r.status = 'voided'
    and not exists (select 1 from public.receipts x where x.org_id = r.org_id and x.donation_ids && r.donation_ids and x.status = 'issued')
  union all
  select c.org_id, 'import_conflict:' || c.id, 'import_conflict', c.id, i.campaign_id, null, null, i.imported_at,
         coalesce(c.on_file ->> 'name', 'A donor') || ': the contact list has different details (matched by ' || c.matched_by || ')'
  from public.import_conflicts c
  join public.imports i on i.org_id = c.org_id and i.id = c.import_id
  where c.resolved_at is null and i.reversed_at is null
  union all
  select g.org_id, 'delivery_failed:' || g.id, 'delivery_failed', g.id::text, g.campaign_id, null, null, coalesce(g.failed_at, g.created_at),
         initcap(replace(g.kind, '_', ' ')) || ' by ' || case g.channel when 'sms' then 'text' else 'email' end
           || ' to ' || coalesce(g.to_name || ' (' || g.to_address || ')', g.to_address) || ': ' || coalesce(g.error, 'failed')
  from public.messages g
  where g.status = 'failed' and g.resent_as is null
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
-- Row-level security, logging, access and the minute job
-- ---------------------------------------------------------------------------
alter table public.messaging_settings  enable row level security;
alter table public.messages            enable row level security;
alter table public.message_opt_outs    enable row level security;
alter table public.shared_documents    enable row level security;
alter table public.messaging_providers enable row level security;
revoke all on public.messaging_settings, public.messages, public.message_opt_outs, public.shared_documents, public.messaging_providers from anon;
revoke insert, update, delete on public.messaging_settings, public.messages, public.message_opt_outs, public.shared_documents, public.messaging_providers from authenticated;
revoke select on public.shared_documents from authenticated;

do $$
declare t text;
begin
  foreach t in array array['messaging_settings','messages','message_opt_outs'] loop
    execute format('create policy org_wall on public.%I as restrictive for all to authenticated
                    using (org_id = (select public.current_org_id()))
                    with check (org_id = (select public.current_org_id()))', t);
    execute format('create policy admin_read on public.%I for select to authenticated using ((select public.is_admin()))', t);
  end loop;
end $$;
create policy admin_read on public.messaging_providers for select to authenticated using ((select public.is_admin()));

-- Each message is logged when created; delivery updates would only fill the log.
create trigger log_row_change after insert on public.messages for each row execute function public.log_row_change();
create trigger log_row_change after insert or update or delete on public.messaging_settings for each row execute function public.log_row_change();
create trigger log_row_change after insert or update or delete on public.message_opt_outs for each row execute function public.log_row_change();

do $$
declare f text;
begin
  foreach f in array array[
    'default_from_email()', 'normalize_phone(text)', 'normalize_address(text, text)'
  ] loop
    execute format('revoke execute on function public.%s from anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  foreach f in array array[
    'kick_sender()', 'kick_sender_if_due()', 'check_cron_token(text)',
    'queue_message(uuid, text, text, text, text, text, text, text, text, text, text, timestamptz)',
    'claim_messages(integer)', 'message_sent(uuid, uuid, boolean, text, text, boolean)',
    'message_event(uuid, uuid, text, text, text, timestamptz)', 'sms_inbound(text, text, text)', 'messaging_ready(boolean, boolean)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
  foreach f in array array[
    'check_cron_token(text)', 'claim_messages(integer)', 'message_sent(uuid, uuid, boolean, text, text, boolean)',
    'message_event(uuid, uuid, text, text, text, timestamptz)', 'sms_inbound(text, text, text)', 'messaging_ready(boolean, boolean)'
  ] loop
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
  foreach f in array array[
    'send_test_message(text, text)', 'send_document(text, text, text, text, text, text, text, text, text)',
    'resend_message(uuid, text)', 'save_messaging_settings(text, text, text, text, boolean, text[])', 'remove_opt_out(text, text)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
revoke execute on function public.shared_document(text) from public;
grant execute on function public.shared_document(text) to anon, authenticated;

-- Catches anything queued while the sender couldn't be reached, and anything scheduled for later.
select cron.schedule('send_messages', '* * * * *', $$select public.kick_sender_if_due()$$);
