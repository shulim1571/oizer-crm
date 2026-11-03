-- Phase 7 part 3: sharing a campaign's payment link, and Custom Outreach. Both are marketing sends: each
-- email carries an unsubscribe link and the organization's address, and each text says how to opt out.
-- Unsubscribing stops marketing email only; receipts and notifications still arrive. A text STOP stops
-- every text, as before. Outreach is admin-only: recipients from the database, groups or typed in, by
-- email, text or both, personalized, optionally scheduled, with a PDF attachment and saved templates.
-- Email opens and clicks are tracked per recipient and rolled up per send.

-- ---------------------------------------------------------------------------
-- Messages: cancelled (a scheduled send called off) and an unsubscribe token on marketing email
-- ---------------------------------------------------------------------------
alter table public.messages drop constraint messages_status_check;
alter table public.messages add constraint messages_status_check
  check (status in ('queued','sending','sent','delivered','failed','opted_out','held','cancelled'));
alter table public.messages add column unsubscribe_token text;
create unique index messages_unsubscribe on public.messages (unsubscribe_token) where unsubscribe_token is not null;

create or replace function public.is_marketing(p_kind text) returns boolean
language sql immutable as $$ select p_kind in ('share','outreach') $$;

-- ---------------------------------------------------------------------------
-- Outreach sends and templates
-- ---------------------------------------------------------------------------
create table public.outreach_sends (
  org_id           uuid not null default public.current_org_id() references public.organizations(id),
  id               uuid not null default gen_random_uuid(),
  channel          text not null check (channel in ('email','sms','both')),
  subject          text,
  body             text,
  sms_body         text,
  attachment_name  text,
  attachment       text,
  send_after       timestamptz not null default now(),
  recipient_count  integer not null default 0,
  queued_count     integer not null default 0,
  skipped          jsonb not null default '[]',
  cancelled_at     timestamptz,
  cancelled_by     text,
  created_by       text default public.current_email(),
  created_at       timestamptz not null default now(),
  primary key (org_id, id)
);

create table public.outreach_templates (
  org_id      uuid not null default public.current_org_id() references public.organizations(id),
  id          text not null default public.short_id(),
  name        text not null check (trim(name) <> ''),
  subject     text,
  body        text,
  sms_body    text,
  updated_by  text default public.current_email(),
  updated_at  timestamptz not null default now(),
  primary key (org_id, id)
);

-- ---------------------------------------------------------------------------
-- Formatting
-- ---------------------------------------------------------------------------
-- What the office types, made safe for email: **bold**, *italic*, web addresses become links, and
-- line breaks are kept. Nothing else typed can become HTML.
create or replace function public.format_message_html(p text) returns text
language sql immutable as $$
  select replace(
           regexp_replace(
             regexp_replace(
               regexp_replace(public.html_escape(p), '(https?://[^\s<]+[^\s<.,;:!?)])', '<a href="\1">\1</a>', 'g'),
               '\*\*([^*\n]+)\*\*', '<b>\1</b>', 'g'),
             '(^|[^*])\*([^*\n]+)\*', '\1<i>\2</i>', 'g'),
           E'\n', '<br>')
$$;

-- A marketing email: the organization's name, the message, and a footer with its address and the
-- unsubscribe link. {{unsubscribe_url}} is filled in per message by queue_message.
create or replace function public.marketing_html(p_org uuid, p_heading text, p_body_html text) returns text
language sql stable security definer set search_path = '' as $$
  select '<!doctype html><html><body style="margin:0;background:#f5f6f8;font-family:Arial,Helvetica,sans-serif;color:#111">'
    || '<div style="max-width:600px;margin:0 auto;padding:24px 16px">'
    || '<div style="font-size:13px;color:#555;margin-bottom:10px">'
    || case when o.logo_url is not null then '<img src="' || public.html_escape(o.logo_url) || '" alt="" style="max-height:36px;vertical-align:middle;margin-right:8px">' else '' end
    || public.html_escape(o.name) || '</div>'
    || '<div style="background:#fff;border:1px solid #e7e9ee;border-radius:10px;padding:22px;font-size:15px;line-height:1.55">'
    || case when nullif(trim(p_heading), '') is not null then '<h1 style="font-size:19px;margin:0 0 14px">' || public.html_escape(p_heading) || '</h1>' else '' end
    || p_body_html
    || '</div><div style="font-size:11px;color:#888;margin-top:12px;line-height:1.5">'
    || public.html_escape(coalesce(o.legal_name, o.name)) || coalesce(' · ' || public.html_escape(o.address), '')
    || '<br><a href="{{unsubscribe_url}}" style="color:#888">Unsubscribe</a> from messages like this one.'
    || '</div></div></body></html>'
  from public.organizations o where o.id = p_org
$$;

-- ---------------------------------------------------------------------------
-- queue_message: email unsubscribes block marketing only; marketing email gets its unsubscribe link
-- ---------------------------------------------------------------------------
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
  v_token text;
  v_unsub text;
  v_body text := p_body;
  v_html text := p_html;
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
  if p_channel = 'email' and public.is_marketing(p_kind) then
    v_token := encode(extensions.gen_random_bytes(16), 'hex');
    v_unsub := coalesce(public.portal_url(p_org), '') || '#/u/' || v_token;
    v_html := replace(v_html, '{{unsubscribe_url}}', public.html_escape(v_unsub));
    v_body := v_body || E'\n\n--\nUnsubscribe: ' || v_unsub;
  end if;
  if exists (select 1 from public.message_opt_outs o where o.org_id = p_org and o.channel = p_channel and o.address = v_to)
     and (p_channel = 'sms' or public.is_marketing(p_kind)) then
    v_status := 'opted_out';
    v_error := case p_channel when 'sms' then 'This number replied STOP. It gets texts again after replying START'
                              else 'This address unsubscribed from messages like this one' end;
  elsif not coalesce(s.live, false)
        and not exists (select 1 from unnest(coalesce(s.test_recipients, '{}')) t where public.normalize_address(p_channel, t) = v_to) then
    v_status := 'held';
    v_error := 'Held: sending is in test mode and this address isn''t on the test list';
  end if;
  insert into public.messages (org_id, channel, to_address, to_name, subject, body, html, kind, record_id, donor_id, campaign_id,
                               status, error, send_after, unsubscribe_token)
  values (p_org, p_channel, v_to, nullif(trim(p_to_name), ''), nullif(trim(p_subject), ''), v_body, v_html, p_kind,
          p_record_id, p_donor, p_campaign, v_status, v_error, coalesce(p_send_after, now()), v_token)
  returning id into v_id;
  if v_status = 'queued' and coalesce(p_send_after, now()) <= now() and coalesce(current_setting('app.batch_send', true), '') <> 'on' then
    perform public.kick_sender();
  end if;
  return v_id;
end $$;

-- The sender also gets the unsubscribe address (for the List-Unsubscribe header) and any attachment.
drop function public.claim_messages(integer);
create function public.claim_messages(p_limit integer default 50)
returns table (org_id uuid, id uuid, channel text, to_address text, to_name text, subject text, body text, html text, kind text,
               from_name text, from_email text, reply_to text, sms_from text,
               unsubscribe_url text, attachment_name text, attachment text)
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
         coalesce(s.from_name, o.name), coalesce(s.from_email, public.default_from_email()), coalesce(s.reply_to, lower(o.email)), s.sms_from,
         case when t.unsubscribe_token is not null then coalesce(public.portal_url(t.org_id), '') || '#/u/' || t.unsubscribe_token end,
         x.attachment_name, x.attachment
  from taken t
  join public.organizations o on o.id = t.org_id
  left join public.messaging_settings s on s.org_id = t.org_id
  left join public.outreach_sends x on t.kind = 'outreach' and x.org_id = t.org_id and x.id::text = t.record_id and x.attachment is not null
$$;
revoke execute on function public.claim_messages(integer) from public, anon, authenticated;
grant execute on function public.claim_messages(integer) to service_role;

-- Delivery reports gain unsubscribes and spam complaints from SendGrid, which stop marketing email.
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
    when p_event in ('unsubscribe','group_unsubscribe','spamreport') and m.channel = 'email' then
      insert into public.message_opt_outs (org_id, channel, address, source)
      values (m.org_id, 'email', m.to_address, case when p_event = 'spamreport' then 'spam report' else 'unsubscribe' end)
      on conflict do nothing;
    else null;
  end case;
end $$;

-- Anyone with the link: unsubscribes that address from the organization's marketing email.
create or replace function public.unsubscribe_email(p_token text) returns text
language plpgsql security definer set search_path = '' as $$
declare m public.messages; v_name text;
begin
  select * into m from public.messages where unsubscribe_token = p_token and nullif(p_token, '') is not null;
  if m.id is null then return null; end if;
  insert into public.message_opt_outs (org_id, channel, address, source) values (m.org_id, 'email', m.to_address, 'unsubscribe')
  on conflict do nothing;
  select name into v_name from public.organizations where id = m.org_id;
  return v_name;
end $$;

-- ---------------------------------------------------------------------------
-- Sharing a payment link (admins, and fundraisers on their own campaigns)
-- ---------------------------------------------------------------------------
create or replace function public.can_share_campaign(p_campaign text) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_admin() or (public.is_active_user() and p_campaign = any(public.my_campaign_ids()))
$$;

-- The default wording: the link, then how else to give, from the organization's details.
create or replace function public.share_template(p_org uuid, p_campaign text, p_channel text) returns text
language sql stable security definer set search_path = '' as $$
  select array_to_string(array_remove(array[
           case p_channel when 'sms' then c.payment_link else 'Donate here: ' || c.payment_link end,
           case when nullif(trim(o.check_payee), '') is not null then case p_channel when 'sms' then 'Checks: ' else 'Make checks payable to: ' end || o.check_payee end,
           case when nullif(trim(o.zelle), '') is not null then 'Zelle: ' || o.zelle end,
           case when nullif(trim(o.ein), '') is not null then 'EIN: ' || o.ein end], null), E'\n')
  from public.campaigns c join public.organizations o on o.id = c.org_id
  where c.org_id = p_org and c.id = p_campaign
$$;

create or replace function public.share_campaign_link(
  p_campaign text, p_channel text, p_recipients text[], p_subject text default null, p_message text default null, p_message_below boolean default false
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  c public.campaigns;
  v_name text;
  v_text text;
  v_template text;
  v_to text;
  v_seen text[] := '{}';
  v_queued integer := 0;
  v_skipped jsonb := '[]';
begin
  if not public.can_share_campaign(p_campaign) then raise exception 'You can share links only for your own campaigns'; end if;
  if p_channel not in ('email','sms') then raise exception 'Choose email or text'; end if;
  select * into c from public.campaigns where org_id = v_org and id = p_campaign and deleted_at is null;
  if c.id is null then raise exception 'Campaign not found'; end if;
  if nullif(trim(c.payment_link), '') is null then raise exception 'This campaign has no payment link yet'; end if;
  if coalesce(cardinality(p_recipients), 0) = 0 then raise exception 'Add at least one recipient'; end if;
  if cardinality(p_recipients) > 500 then raise exception 'Share with up to 500 at a time, or use Outreach for larger lists'; end if;
  v_name := coalesce(c.external_name, c.internal_name, c.campaign_name);
  v_template := public.share_template(v_org, p_campaign, p_channel);
  v_text := case
    when nullif(trim(p_message), '') is null then v_template
    when p_message_below then v_template || E'\n\n' || trim(p_message)
    else trim(p_message) || E'\n\n' || v_template end;
  if p_channel = 'sms' then v_text := v_text || E'\nReply STOP to opt out.'; end if;
  foreach v_to in array p_recipients loop
    continue when nullif(trim(v_to), '') is null;
    continue when public.normalize_address(p_channel, v_to) = any(v_seen);
    begin
      perform public.queue_message(v_org, p_channel, v_to, null,
        case when p_channel = 'email' then coalesce(nullif(trim(p_subject), ''), 'Support ' || v_name) end,
        v_text,
        case when p_channel = 'email' then public.marketing_html(v_org, v_name, public.format_message_html(v_text)) end,
        'share', p_campaign, null, p_campaign);
      v_seen := v_seen || public.normalize_address(p_channel, v_to);
      v_queued := v_queued + 1;
    exception when others then
      v_skipped := v_skipped || jsonb_build_object('to', v_to, 'reason', sqlerrm);
    end;
  end loop;
  perform public.write_activity(v_org, 'share_link', 'campaigns', p_campaign, p_campaign,
    jsonb_build_object('channel', p_channel, 'recipients', v_queued));
  return jsonb_build_object('queued', v_queued, 'skipped', v_skipped);
end $$;

-- Who shared this campaign's link, with whom and when, and what became of each.
create or replace function public.campaign_shares(p_campaign text)
returns table (id uuid, created_at timestamptz, created_by text, channel text, to_address text, status text)
language sql stable security definer set search_path = '' as $$
  select m.id, m.created_at, m.created_by, m.channel, m.to_address, m.status
  from public.messages m
  where public.can_share_campaign(p_campaign) and m.org_id = public.current_org_id()
    and m.kind = 'share' and m.campaign_id = p_campaign
  order by m.created_at desc
  limit 500
$$;

-- ---------------------------------------------------------------------------
-- Custom Outreach (admins)
-- ---------------------------------------------------------------------------
-- A ready-made list to start from: a campaign's donors, every donor, every fundraiser or every primary.
create or replace function public.outreach_group(p_group text, p_campaign text default null)
returns table (kind text, id text, name text, email text, phone text, campaign_id text)
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  perform public.require_admin();
  if p_group = 'campaign_donors' then
    return query
      select distinct on (dn.id) 'donor'::text, dn.id, dn.display_name, dn.email, dn.phone, p_campaign
      from public.donations d join public.donors dn on dn.org_id = d.org_id and dn.id = d.donor_id and dn.deleted_at is null
      where d.org_id = v_org and d.campaign_id = p_campaign and d.deleted_at is null and d.status in ('completed','collect')
        and coalesce(d.payment_method, '') <> 'Opening Balance'
      order by dn.id;
  elsif p_group = 'all_donors' then
    return query
      select 'donor'::text, dn.id, dn.display_name, dn.email, dn.phone, null::text
      from public.donors dn
      where dn.org_id = v_org and dn.deleted_at is null and (nullif(trim(dn.email), '') is not null or nullif(trim(dn.phone), '') is not null)
      order by dn.display_name;
  elsif p_group in ('all_fundraisers', 'primary_fundraisers') then
    return query
      select 'fundraiser'::text, m.id, m.full_name, m.email, m.phone, null::text
      from public.managers m
      where m.org_id = v_org and m.deleted_at is null and coalesce(m.status, 'active') = 'active'
        and (p_group = 'all_fundraisers' or exists (select 1 from public.campaigns c where c.org_id = v_org and c.manager_id = m.id
                                                      and c.deleted_at is null and c.status in ('active','draft')))
      order by m.full_name;
  else
    raise exception 'Unknown group';
  end if;
end $$;

-- {first_name}, {last_name} and {campaign_name}, filled for one recipient.
create or replace function public.personalize(p text, p_first text, p_last text, p_campaign text) returns text
language sql immutable as $$
  select replace(replace(replace(coalesce(p, ''), '{first_name}', coalesce(p_first, '')), '{last_name}', coalesce(p_last, '')), '{campaign_name}', coalesce(p_campaign, ''))
$$;

-- Sends one outreach message to everyone listed. Each recipient is {kind: donor|fundraiser|address, id,
-- address, campaign_id}. Donors and fundraisers are looked up; typed addresses aren't added to anything.
-- Anyone without the needed address, or listed twice, is skipped and reported back.
create or replace function public.send_outreach(
  p_channel text, p_subject text, p_body text, p_sms_body text, p_recipients jsonb,
  p_send_after timestamptz default null, p_attachment_name text default null, p_attachment text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  v_id uuid;
  r jsonb;
  v_first text; v_last text; v_name text; v_email text; v_phone text; v_campaign text; v_donor text;
  v_seen text[] := '{}';
  v_queued integer := 0;
  v_skipped jsonb := '[]';
  v_when timestamptz := case when p_send_after > now() then p_send_after end;
  v_sms text;
begin
  perform public.require_admin();
  if p_channel not in ('email','sms','both') then raise exception 'Choose email, text or both'; end if;
  if p_channel <> 'sms' and (nullif(trim(p_subject), '') is null or nullif(trim(p_body), '') is null) then raise exception 'Write a subject and the email'; end if;
  if p_channel <> 'email' and nullif(trim(p_sms_body), '') is null then raise exception 'Write the text message'; end if;
  if jsonb_typeof(p_recipients) <> 'array' or jsonb_array_length(p_recipients) = 0 then raise exception 'Add at least one recipient'; end if;
  if p_attachment is not null then
    if p_channel = 'sms' then raise exception 'Texts can''t carry an attachment'; end if;
    if lower(coalesce(p_attachment_name, '')) not like '%.pdf' then raise exception 'Attach a PDF'; end if;
    if length(p_attachment) > 7000000 then raise exception 'The attachment is too large; keep it under 5 MB'; end if;
  end if;
  insert into public.outreach_sends (org_id, channel, subject, body, sms_body, attachment_name, attachment, send_after, recipient_count)
  values (v_org, p_channel, nullif(trim(p_subject), ''), nullif(trim(p_body), ''), nullif(trim(p_sms_body), ''),
          case when p_attachment is not null then p_attachment_name end, p_attachment, coalesce(v_when, now()), jsonb_array_length(p_recipients))
  returning id into v_id;

  for r in select * from jsonb_array_elements(p_recipients) loop
    v_first := null; v_last := null; v_name := null; v_email := null; v_phone := null; v_donor := null;
    v_campaign := nullif(r ->> 'campaign_id', '');
    if r ->> 'kind' = 'donor' then
      select dn.first_name, dn.last_name, dn.display_name, dn.email, dn.phone, dn.id into v_first, v_last, v_name, v_email, v_phone, v_donor
      from public.donors dn where dn.org_id = v_org and dn.id = r ->> 'id' and dn.deleted_at is null;
    elsif r ->> 'kind' = 'fundraiser' then
      select m.first_name, m.last_name, m.full_name, m.email, m.phone into v_first, v_last, v_name, v_email, v_phone
      from public.managers m where m.org_id = v_org and m.id = r ->> 'id' and m.deleted_at is null;
    else
      v_email := case when position('@' in coalesce(r ->> 'address', '')) > 0 then r ->> 'address' end;
      v_phone := case when position('@' in coalesce(r ->> 'address', '')) = 0 then r ->> 'address' end;
    end if;
    v_campaign := (select coalesce(c.external_name, c.internal_name) from public.campaigns c where c.org_id = v_org and c.id = v_campaign);

    if p_channel in ('email','both') then
      if public.normalize_address('email', v_email) is null then
        if p_channel = 'email' or public.normalize_phone(v_phone) is null then
          v_skipped := v_skipped || jsonb_build_object('to', coalesce(v_name, r ->> 'address', r ->> 'id'), 'reason', 'No valid email address');
        end if;
      elsif public.normalize_address('email', v_email) = any(v_seen) then
        null;
      else
        begin
          perform public.queue_message(v_org, 'email', v_email, v_name,
            public.personalize(p_subject, v_first, v_last, v_campaign),
            public.personalize(p_body, v_first, v_last, v_campaign),
            public.marketing_html(v_org, null, public.format_message_html(public.personalize(p_body, v_first, v_last, v_campaign))),
            'outreach', v_id::text, v_donor, nullif(r ->> 'campaign_id', ''), v_when);
          v_seen := v_seen || public.normalize_address('email', v_email);
          v_queued := v_queued + 1;
        exception when others then
          v_skipped := v_skipped || jsonb_build_object('to', coalesce(v_name, v_email), 'reason', sqlerrm);
        end;
      end if;
    end if;

    if p_channel in ('sms','both') then
      if public.normalize_phone(v_phone) is null then
        if p_channel = 'sms' or public.normalize_address('email', v_email) is null then
          v_skipped := v_skipped || jsonb_build_object('to', coalesce(v_name, r ->> 'address', r ->> 'id'), 'reason', 'No valid phone number');
        end if;
      elsif public.normalize_phone(v_phone) = any(v_seen) then
        null;
      else
        v_sms := public.personalize(p_sms_body, v_first, v_last, v_campaign) || E'\nReply STOP to opt out.';
        begin
          perform public.queue_message(v_org, 'sms', v_phone, v_name, null, v_sms, null,
            'outreach', v_id::text, v_donor, nullif(r ->> 'campaign_id', ''), v_when);
          v_seen := v_seen || public.normalize_phone(v_phone);
          v_queued := v_queued + 1;
        exception when others then
          v_skipped := v_skipped || jsonb_build_object('to', coalesce(v_name, v_phone), 'reason', sqlerrm);
        end;
      end if;
    end if;
  end loop;

  update public.outreach_sends set queued_count = v_queued, skipped = v_skipped where org_id = v_org and id = v_id;
  perform public.write_activity(v_org, 'send_outreach', 'outreach_sends', v_id::text, null,
    jsonb_build_object('channel', p_channel, 'subject', nullif(trim(p_subject), ''), 'recipients', jsonb_array_length(p_recipients),
                       'queued', v_queued, 'scheduled_for', v_when));
  return jsonb_build_object('id', v_id, 'queued', v_queued, 'skipped', v_skipped);
end $$;

-- Calls off whatever of a scheduled send hasn't gone yet.
create or replace function public.cancel_outreach(p_id uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_count integer;
begin
  perform public.require_admin();
  update public.messages set status = 'cancelled', error = 'Cancelled before it was sent'
  where org_id = v_org and kind = 'outreach' and record_id = p_id::text and status = 'queued';
  get diagnostics v_count = row_count;
  update public.outreach_sends set cancelled_at = now(), cancelled_by = public.current_email() where org_id = v_org and id = p_id and cancelled_at is null;
  return v_count;
end $$;

create or replace function public.save_outreach_template(p_id text, p_name text, p_subject text, p_body text, p_sms_body text) returns text
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_id text;
begin
  perform public.require_admin();
  if nullif(trim(p_name), '') is null then raise exception 'Name the template'; end if;
  if p_id is null then
    insert into public.outreach_templates (org_id, name, subject, body, sms_body)
    values (v_org, trim(p_name), nullif(trim(p_subject), ''), nullif(trim(p_body), ''), nullif(trim(p_sms_body), ''))
    returning id into v_id;
  else
    update public.outreach_templates set name = trim(p_name), subject = nullif(trim(p_subject), ''), body = nullif(trim(p_body), ''),
      sms_body = nullif(trim(p_sms_body), ''), updated_by = public.current_email(), updated_at = now()
    where org_id = v_org and id = p_id returning id into v_id;
    if v_id is null then raise exception 'Template not found'; end if;
  end if;
  return v_id;
end $$;

create or replace function public.delete_outreach_template(p_id text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_admin();
  delete from public.outreach_templates where org_id = public.current_org_id() and id = p_id;
end $$;

-- Each send with its delivery, open and click counts.
create view public.outreach_list with (security_invoker = true) as
select s.org_id, s.id, s.channel, s.subject, s.body, s.sms_body, s.attachment_name, s.send_after, s.recipient_count, s.queued_count,
       s.skipped, s.cancelled_at, s.cancelled_by, s.created_by, s.created_at,
       coalesce(t.sent, 0) as sent, coalesce(t.delivered, 0) as delivered, coalesce(t.failed, 0) as failed,
       coalesce(t.held, 0) as held, coalesce(t.waiting, 0) as waiting, coalesce(t.emails, 0) as emails,
       coalesce(t.opened, 0) as opened, coalesce(t.clicked, 0) as clicked
from public.outreach_sends s
left join lateral (
  select count(*) filter (where m.status in ('sent','delivered')) as sent,
         count(*) filter (where m.status = 'delivered') as delivered,
         count(*) filter (where m.status in ('failed','opted_out')) as failed,
         count(*) filter (where m.status = 'held') as held,
         count(*) filter (where m.status in ('queued','sending')) as waiting,
         count(*) filter (where m.channel = 'email' and m.status in ('sent','delivered')) as emails,
         count(*) filter (where m.opened_at is not null) as opened,
         count(*) filter (where m.clicked_at is not null) as clicked
  from public.messages m where m.org_id = s.org_id and m.kind = 'outreach' and m.record_id = s.id::text
) t on true;

-- ---------------------------------------------------------------------------
-- Row-level security, logging and access
-- ---------------------------------------------------------------------------
alter table public.outreach_sends     enable row level security;
alter table public.outreach_templates enable row level security;
revoke all on public.outreach_sends, public.outreach_templates, public.outreach_list from anon;
revoke insert, update, delete on public.outreach_sends, public.outreach_templates from authenticated;
do $$
declare t text;
begin
  foreach t in array array['outreach_sends','outreach_templates'] loop
    execute format('create policy org_wall on public.%I as restrictive for all to authenticated
                    using (org_id = (select public.current_org_id()))
                    with check (org_id = (select public.current_org_id()))', t);
    execute format('create policy admin_read on public.%I for select to authenticated using ((select public.is_admin()))', t);
    execute format('create trigger log_row_change after insert or update or delete on public.%I for each row execute function public.log_row_change()', t);
  end loop;
end $$;
grant select on public.outreach_list to authenticated;

do $$
declare f text;
begin
  foreach f in array array['marketing_html(uuid, text, text)', 'share_template(uuid, text, text)'] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
  foreach f in array array['is_marketing(text)', 'format_message_html(text)', 'personalize(text, text, text, text)'] loop
    execute format('revoke execute on function public.%s from anon', f);
  end loop;
  foreach f in array array[
    'can_share_campaign(text)', 'share_campaign_link(text, text, text[], text, text, boolean)', 'campaign_shares(text)',
    'outreach_group(text, text)', 'send_outreach(text, text, text, text, jsonb, timestamptz, text, text)', 'cancel_outreach(uuid)',
    'save_outreach_template(text, text, text, text, text)', 'delete_outreach_template(text)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
revoke execute on function public.unsubscribe_email(text) from public;
grant execute on function public.unsubscribe_email(text) to anon, authenticated;
