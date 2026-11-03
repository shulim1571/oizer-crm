-- Phase 7 part 4: messaging inside the portal. Each fundraiser has one conversation with the office, which
-- every admin shares; fundraisers can't write to each other except in a campaign's group chat, which an
-- admin turns on. Messages can carry a voice note of up to two minutes. Read receipts come from when each
-- person last opened a conversation. Admins have quick replies (kept by the Super Admin), one pinned
-- announcement every fundraiser sees, and broadcasts that land in each chosen fundraiser's conversation.
-- New messages are emailed: to fundraisers when the office writes, and to admins as each one chose.

-- ---------------------------------------------------------------------------
-- Conversations and messages
-- ---------------------------------------------------------------------------
create table public.threads (
  org_id           uuid not null default public.current_org_id() references public.organizations(id),
  id               uuid not null default gen_random_uuid(),
  kind             text not null check (kind in ('direct','group')),
  manager_id       text,
  campaign_id      text,
  enabled          boolean not null default true,
  created_at       timestamptz not null default now(),
  last_message_at  timestamptz,
  primary key (org_id, id),
  check ((kind = 'direct' and manager_id is not null and campaign_id is null) or (kind = 'group' and campaign_id is not null and manager_id is null))
);
create unique index threads_direct on public.threads (org_id, manager_id) where kind = 'direct';
create unique index threads_group on public.threads (org_id, campaign_id) where kind = 'group';

create table public.broadcasts (
  org_id           uuid not null default public.current_org_id() references public.organizations(id),
  id               uuid not null default gen_random_uuid(),
  audience         text not null check (audience in ('all','primary','chosen')),
  body             text not null,
  recipient_count  integer not null default 0,
  created_by       text default public.current_email(),
  created_at       timestamptz not null default now(),
  primary key (org_id, id)
);

create table public.thread_messages (
  org_id         uuid not null default public.current_org_id() references public.organizations(id),
  id             uuid not null default gen_random_uuid(),
  thread_id      uuid not null,
  sender_user    uuid default auth.uid(),
  sender_name    text not null,
  from_office    boolean not null,
  body           text,
  voice_seconds  integer check (voice_seconds between 1 and 120),
  broadcast_id   uuid,
  created_at     timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, thread_id) references public.threads (org_id, id),
  check (nullif(trim(body), '') is not null or voice_seconds is not null)
);
create index on public.thread_messages (org_id, thread_id, created_at);

-- Voice notes apart from the messages, so a conversation loads without them.
create table public.voice_notes (
  org_id      uuid not null references public.organizations(id),
  message_id  uuid not null,
  mime        text not null,
  data        bytea not null,
  primary key (org_id, message_id),
  foreign key (org_id, message_id) references public.thread_messages (org_id, id)
);

-- When each person last read each conversation.
create table public.thread_reads (
  org_id     uuid not null references public.organizations(id),
  thread_id  uuid not null,
  user_id    uuid not null,
  read_at    timestamptz not null default now(),
  primary key (org_id, thread_id, user_id)
);

create table public.quick_replies (
  org_id      uuid not null default public.current_org_id() references public.organizations(id),
  id          text not null default public.short_id(),
  body        text not null check (trim(body) <> ''),
  sort        integer not null default 0,
  primary key (org_id, id)
);
insert into public.quick_replies (org_id, body, sort)
select o.id, r.body, r.sort from public.organizations o
cross join (values ('Your campaign is ready', 1), ('Payout has been processed', 2), ('Please call me', 3),
                   ('We received your batch', 4), ('Your request is approved', 5)) r(body, sort);

create table public.announcements (
  org_id      uuid not null default public.current_org_id() references public.organizations(id),
  id          uuid not null default gen_random_uuid(),
  body        text not null check (trim(body) <> ''),
  posted_by   text default public.current_email(),
  posted_at   timestamptz not null default now(),
  removed_at  timestamptz,
  removed_by  text,
  primary key (org_id, id)
);
create unique index announcements_one on public.announcements (org_id) where removed_at is null;

-- Admins choose how new fundraiser messages reach them.
alter table public.notification_preferences add column message_alerts text not null default 'immediate'
  check (message_alerts in ('immediate','digest','off'));

-- ---------------------------------------------------------------------------
-- Who sees what
-- ---------------------------------------------------------------------------
create or replace function public.can_see_thread(p_thread uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.threads t
    where t.org_id = public.current_org_id() and t.id = p_thread
      and (public.is_admin()
           or (public.is_active_user() and (
                (t.kind = 'direct' and t.manager_id = any(public.my_manager_ids()))
                or (t.kind = 'group' and t.enabled and t.campaign_id = any(public.my_campaign_ids())))))
  )
$$;

-- The name a message is signed with: a fundraiser's name, or an admin's name or email.
create or replace function public.my_display_name() returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(
    case when public.is_admin() then null else (select m.full_name from public.managers m where m.org_id = public.current_org_id() and m.id = any(public.my_manager_ids()) limit 1) end,
    (select nullif(trim(u.raw_user_meta_data ->> 'full_name'), '') from auth.users u where u.id = auth.uid()),
    public.current_email())
$$;

-- ---------------------------------------------------------------------------
-- The inbox
-- ---------------------------------------------------------------------------
-- My conversations with their unread count and last message. A fundraiser always sees their own
-- conversation with the office, even before anyone has written.
create or replace function public.my_threads()
returns table (id uuid, kind text, title text, manager_id text, campaign_id text, enabled boolean,
               last_message_at timestamptz, last_preview text, last_from text, unread integer)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_admin boolean := public.is_admin();
begin
  if not public.is_active_user() then return; end if;
  if not v_admin then
    insert into public.threads (org_id, kind, manager_id)
    select v_org, 'direct', m from unnest(public.my_manager_ids()) m
    where exists (select 1 from public.managers x where x.org_id = v_org and x.id = m and x.deleted_at is null)
    on conflict do nothing;
  end if;
  return query
    select t.id, t.kind,
           case when t.kind = 'group' then coalesce(c.internal_name, c.external_name, c.campaign_name, '') || ' (' || t.campaign_id || ') group'
                when v_admin then coalesce(m.full_name, t.manager_id)
                else 'The office' end,
           t.manager_id, t.campaign_id, t.enabled, t.last_message_at,
           (select left(coalesce(nullif(trim(x.body), ''), 'Voice message'), 120) from public.thread_messages x
            where x.org_id = t.org_id and x.thread_id = t.id order by x.created_at desc limit 1),
           (select x.sender_name from public.thread_messages x where x.org_id = t.org_id and x.thread_id = t.id order by x.created_at desc limit 1),
           (select count(*)::int from public.thread_messages x
            where x.org_id = t.org_id and x.thread_id = t.id and x.sender_user is distinct from auth.uid()
              and x.created_at > coalesce((select r.read_at from public.thread_reads r where r.org_id = t.org_id and r.thread_id = t.id and r.user_id = auth.uid()), '-infinity'))
    from public.threads t
    left join public.managers m on m.org_id = t.org_id and m.id = t.manager_id
    left join public.campaigns c on c.org_id = t.org_id and c.id = t.campaign_id
    where t.org_id = v_org and public.can_see_thread(t.id)
      and (t.kind = 'group' or not v_admin or t.last_message_at is not null)
    order by t.last_message_at desc nulls last, 3;
end $$;

create or replace function public.unread_message_count() returns integer
language sql security definer set search_path = '' as $$
  select coalesce(sum(t.unread), 0)::int from public.my_threads() t
$$;

-- Admin: the conversation with a fundraiser, started if needed.
create or replace function public.open_direct_thread(p_manager text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_id uuid;
begin
  perform public.require_admin();
  if not exists (select 1 from public.managers m where m.org_id = v_org and m.id = p_manager and m.deleted_at is null) then
    raise exception 'Fundraiser not found';
  end if;
  insert into public.threads (org_id, kind, manager_id) values (v_org, 'direct', p_manager) on conflict do nothing;
  select id into v_id from public.threads where org_id = v_org and kind = 'direct' and manager_id = p_manager;
  return v_id;
end $$;

-- Admin: turns a campaign's group chat on or off. Turning it off hides it from fundraisers; the history stays.
create or replace function public.set_group_chat(p_campaign text, p_enabled boolean) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_id uuid;
begin
  perform public.require_admin();
  if not exists (select 1 from public.campaigns c where c.org_id = v_org and c.id = p_campaign and c.deleted_at is null) then
    raise exception 'Campaign not found';
  end if;
  insert into public.threads (org_id, kind, campaign_id, enabled) values (v_org, 'group', p_campaign, p_enabled)
  on conflict (org_id, campaign_id) where kind = 'group' do update set enabled = excluded.enabled;
  select id into v_id from public.threads where org_id = v_org and kind = 'group' and campaign_id = p_campaign;
  return v_id;
end $$;

create or replace function public.mark_thread_read(p_thread uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.can_see_thread(p_thread) then return; end if;
  insert into public.thread_reads (org_id, thread_id, user_id, read_at) values (public.current_org_id(), p_thread, auth.uid(), now())
  on conflict (org_id, thread_id, user_id) do update set read_at = now();
end $$;

-- A conversation's messages, each with when the other side read it: the office (any admin) for a
-- fundraiser's message, the fundraiser for the office's.
create or replace function public.thread_history(p_thread uuid)
returns table (id uuid, sender_name text, from_office boolean, mine boolean, body text, voice_seconds integer,
               broadcast boolean, created_at timestamptz, read_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select x.id, x.sender_name, x.from_office, x.sender_user is not distinct from auth.uid(), x.body, x.voice_seconds,
         x.broadcast_id is not null, x.created_at,
         (select min(r.read_at) from public.thread_reads r
          join public.org_members om on om.org_id = r.org_id and om.user_id = r.user_id
          where r.org_id = x.org_id and r.thread_id = x.thread_id and r.read_at >= x.created_at and r.user_id is distinct from x.sender_user
            and (om.role in ('super_admin','admin')) <> x.from_office)
  from public.thread_messages x
  where public.can_see_thread(p_thread) and x.org_id = public.current_org_id() and x.thread_id = p_thread
  order by x.created_at
$$;

-- A voice note to play or download.
create or replace function public.voice_note(p_message uuid) returns table (mime text, data text)
language sql stable security definer set search_path = '' as $$
  select v.mime, encode(v.data, 'base64')
  from public.voice_notes v join public.thread_messages x on x.org_id = v.org_id and x.id = v.message_id
  where v.org_id = public.current_org_id() and v.message_id = p_message and public.can_see_thread(x.thread_id)
$$;

-- ---------------------------------------------------------------------------
-- Writing
-- ---------------------------------------------------------------------------
-- Emails the other side of a new message. Someone already emailed about this conversation in the last
-- ten minutes, who hasn't opened it since, isn't emailed again.
create or replace function public.notify_thread_message(p_org uuid, p_thread uuid, p_message uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  t public.threads;
  x public.thread_messages;
  p record;
  v_portal text := public.portal_url(p_org);
  v_title text;
  v_preview text;
begin
  select * into t from public.threads where org_id = p_org and id = p_thread;
  select * into x from public.thread_messages where org_id = p_org and id = p_message;
  v_preview := coalesce(nullif(trim(x.body), ''), 'A voice message');
  if length(v_preview) > 280 then v_preview := left(v_preview, 277) || '…'; end if;
  v_title := case when t.kind = 'group' then public.campaign_label(p_org, t.campaign_id) || ' group' end;
  for p in
    -- Fundraisers in the conversation, when the office writes or (in a group) another fundraiser does.
    select m.email, m.phone, m.full_name as name,
           coalesce((select np.channels ->> 'messages' from public.user_managers um join public.notification_preferences np on np.org_id = p_org and np.user_id = um.user_id
                     where um.org_id = p_org and um.manager_id = m.id limit 1), 'email') as channel,
           (select array_agg(um.user_id) from public.user_managers um where um.org_id = p_org and um.manager_id = m.id) as users
    from public.managers m
    where m.org_id = p_org and m.deleted_at is null and coalesce(m.status, 'active') = 'active'
      and ((t.kind = 'direct' and m.id = t.manager_id and x.from_office)
           or (t.kind = 'group' and m.id in (select c.manager_id from public.campaigns c where c.org_id = p_org and c.id = t.campaign_id
                                             union select unnest(c.sub_manager_ids) from public.campaigns c where c.org_id = p_org and c.id = t.campaign_id)))
      and not exists (select 1 from public.user_managers um where um.org_id = p_org and um.manager_id = m.id and um.user_id = x.sender_user)
    union all
    -- Admins, when a fundraiser writes, if they want it right away.
    select a.email, a.phone, a.name, (a.prefs).channels ->> 'messages', array[a.user_id]
    from public.notice_admins(p_org) a
    where not x.from_office and (a.prefs).message_alerts = 'immediate'
  loop
    continue when exists (
      select 1 from public.messages g
      where g.org_id = p_org and g.kind = 'chat' and g.record_id = p_thread::text and g.to_address = lower(p.email)
        and g.created_at > now() - interval '10 minutes'
        and not exists (select 1 from public.thread_reads r where r.org_id = p_org and r.thread_id = p_thread
                        and r.user_id = any(coalesce(p.users, '{}')) and r.read_at > g.created_at));
    perform public.notify_person(p_org, p.email, p.phone, p.name, p.channel, 'chat',
      'New message from ' || x.sender_name || coalesce(' in ' || v_title, ''),
      array[public.format_message_html(v_preview)],
      v_portal || '#/inbox/' || p_thread, 'Open the conversation', p_thread::text, t.campaign_id);
  end loop;
end $$;

create or replace function public.post_message(
  p_thread uuid, p_body text, p_voice text default null, p_voice_mime text default null, p_voice_seconds integer default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  v_id uuid;
  v_data bytea;
begin
  if not public.can_see_thread(p_thread) then raise exception 'You can''t write in this conversation'; end if;
  if nullif(trim(p_body), '') is null and p_voice is null then raise exception 'Write a message or record one'; end if;
  if length(p_body) > 5000 then raise exception 'Keep a message under 5,000 characters'; end if;
  if p_voice is not null then
    if p_voice_seconds is null or p_voice_seconds > 120 then raise exception 'A voice message can be up to 2 minutes'; end if;
    if p_voice_mime is null or p_voice_mime not like 'audio/%' then raise exception 'That isn''t a recording'; end if;
    v_data := decode(p_voice, 'base64');
    if length(v_data) > 3000000 then raise exception 'The recording is too large'; end if;
  end if;
  insert into public.thread_messages (org_id, thread_id, sender_name, from_office, body, voice_seconds)
  values (v_org, p_thread, public.my_display_name(), public.is_admin(), nullif(trim(p_body), ''),
          case when p_voice is not null then greatest(p_voice_seconds, 1) end)
  returning id into v_id;
  if v_data is not null then
    insert into public.voice_notes (org_id, message_id, mime, data) values (v_org, v_id, p_voice_mime, v_data);
  end if;
  update public.threads set last_message_at = now() where org_id = v_org and id = p_thread;
  perform public.mark_thread_read(p_thread);
  perform public.notify_thread_message(v_org, p_thread, v_id);
  return v_id;
end $$;

-- Admin: one message into each chosen fundraiser's conversation with the office. Replies come back
-- in that conversation like any other.
create or replace function public.send_broadcast(p_audience text, p_body text, p_managers text[] default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  v_id uuid;
  v_thread uuid;
  v_msg uuid;
  m record;
  v_count integer := 0;
  v_name text := public.my_display_name();
begin
  perform public.require_admin();
  if nullif(trim(p_body), '') is null then raise exception 'Write the broadcast'; end if;
  if p_audience not in ('all','primary','chosen') then raise exception 'Choose who gets it'; end if;
  if p_audience = 'chosen' and coalesce(cardinality(p_managers), 0) = 0 then raise exception 'Choose at least one fundraiser'; end if;
  insert into public.broadcasts (org_id, audience, body) values (v_org, p_audience, trim(p_body)) returning id into v_id;
  for m in
    select x.id from public.managers x
    where x.org_id = v_org and x.deleted_at is null and coalesce(x.status, 'active') = 'active'
      and case p_audience
            when 'chosen' then x.id = any(p_managers)
            when 'primary' then exists (select 1 from public.campaigns c where c.org_id = v_org and c.manager_id = x.id and c.deleted_at is null and c.status in ('active','draft'))
            else true end
  loop
    insert into public.threads (org_id, kind, manager_id) values (v_org, 'direct', m.id) on conflict do nothing;
    select id into v_thread from public.threads where org_id = v_org and kind = 'direct' and manager_id = m.id;
    insert into public.thread_messages (org_id, thread_id, sender_name, from_office, body, broadcast_id)
    values (v_org, v_thread, v_name, true, trim(p_body), v_id) returning id into v_msg;
    update public.threads set last_message_at = now() where org_id = v_org and id = v_thread;
    perform public.notify_thread_message(v_org, v_thread, v_msg);
    v_count := v_count + 1;
  end loop;
  update public.broadcasts set recipient_count = v_count where org_id = v_org and id = v_id;
  return jsonb_build_object('id', v_id, 'recipients', v_count);
end $$;

-- Admin: pins an announcement in every fundraiser's inbox, replacing any other, and emails it once.
create or replace function public.post_announcement(p_body text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_id uuid; m record; v_portal text;
begin
  perform public.require_admin();
  if nullif(trim(p_body), '') is null then raise exception 'Write the announcement'; end if;
  update public.announcements set removed_at = now(), removed_by = public.current_email() where org_id = v_org and removed_at is null;
  insert into public.announcements (org_id, body) values (v_org, trim(p_body)) returning id into v_id;
  v_portal := public.portal_url(v_org);
  for m in select x.email, x.phone, x.full_name from public.managers x
           where x.org_id = v_org and x.deleted_at is null and coalesce(x.status, 'active') = 'active' loop
    perform public.notify_person(v_org, m.email, m.phone, m.full_name, 'email', 'announcement',
      'Announcement from ' || (select name from public.organizations where id = v_org),
      array[public.format_message_html(trim(p_body))], v_portal || '#/inbox', 'Open your messages', v_id::text);
  end loop;
  return v_id;
end $$;

create or replace function public.remove_announcement() returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_admin();
  update public.announcements set removed_at = now(), removed_by = public.current_email()
  where org_id = public.current_org_id() and removed_at is null;
end $$;

-- Super Admin: the quick replies every admin can send with one tap.
create or replace function public.save_quick_reply(p_id text, p_body text, p_sort integer default 0) returns text
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_id text;
begin
  if not public.is_super_admin() then raise exception 'Only the Super Admin can change quick replies'; end if;
  if nullif(trim(p_body), '') is null then raise exception 'Write the reply'; end if;
  if p_id is null then
    insert into public.quick_replies (org_id, body, sort) values (v_org, trim(p_body), coalesce(p_sort, 0)) returning id into v_id;
  else
    update public.quick_replies set body = trim(p_body), sort = coalesce(p_sort, sort) where org_id = v_org and id = p_id returning id into v_id;
  end if;
  return v_id;
end $$;

create or replace function public.delete_quick_reply(p_id text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_super_admin() then raise exception 'Only the Super Admin can change quick replies'; end if;
  delete from public.quick_replies where org_id = public.current_org_id() and id = p_id;
end $$;

-- ---------------------------------------------------------------------------
-- The morning digest of unread fundraiser messages, for admins who chose it
-- ---------------------------------------------------------------------------
create or replace function public.notify_message_digest(p_org uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare a record; v_items text[]; v_portal text := public.portal_url(p_org);
begin
  for a in select * from public.notice_admins(p_org) x where (x.prefs).message_alerts = 'digest' loop
    select array_agg(public.html_escape(coalesce(m.full_name, c.internal_name, 'A conversation')) || ': ' || n.unread || ' unread' order by n.unread desc)
    into v_items
    from (
      select t.id, t.manager_id, t.campaign_id, count(*) as unread
      from public.threads t
      join public.thread_messages x on x.org_id = t.org_id and x.thread_id = t.id and not x.from_office
      where t.org_id = p_org
        and x.created_at > coalesce((select r.read_at from public.thread_reads r where r.org_id = t.org_id and r.thread_id = t.id and r.user_id = a.user_id), '-infinity')
      group by t.id, t.manager_id, t.campaign_id
    ) n
    left join public.managers m on m.org_id = p_org and m.id = n.manager_id
    left join public.campaigns c on c.org_id = p_org and c.id = n.campaign_id;
    continue when v_items is null;
    perform public.notify_person(p_org, a.email, a.phone, a.name, (a.prefs).channels ->> 'digests', 'message_digest',
      'Unread messages from fundraisers', v_items, v_portal || '#/inbox', 'Open the inbox');
  end loop;
end $$;

create or replace function public.run_notifications() returns void
language plpgsql security definer set search_path = '' as $$
declare
  o record;
  v_local timestamp;
  v_digest time;
begin
  perform public.start_notifications();
  perform set_config('app.batch_send', 'on', true);
  for o in select s.* from public.notification_state s join public.organizations g on g.id = s.org_id where g.status = 'active' loop
    begin
      perform public.notify_donations(o.org_id);
      perform public.notify_tasks(o.org_id);
      v_local := now() at time zone public.org_zone(o.org_id);
      if v_local::time >= time '08:00' and o.last_morning is distinct from v_local::date then
        update public.notification_state set last_morning = v_local::date where org_id = o.org_id;
        perform public.notify_morning(o.org_id);
        perform public.notify_message_digest(o.org_id);
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
      insert into public.job_runs (job, finished_at, ok, error) values ('notifications', now(), false, o.org_id || ': ' || sqlerrm);
    end;
  end loop;
  perform set_config('app.batch_send', 'off', true);
  perform public.kick_sender_if_due();
end $$;

-- Preferences gain the message setting, and the admin list fills it in for anyone without a row.
drop function public.save_notification_preferences(text, text, numeric, text[], text, text, text, boolean, jsonb);
create function public.save_notification_preferences(
  p_phone text, p_donation_alerts text, p_donation_min numeric, p_donation_campaigns text[], p_donation_digest text,
  p_task_alerts text, p_payout_alerts text, p_weekly_digests boolean, p_channels jsonb, p_message_alerts text default 'immediate'
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
                                               task_alerts, payout_alerts, weekly_digests, channels, message_alerts, updated_at)
  values (v_org, auth.uid(), public.normalize_phone(p_phone),
          case when v_admin then coalesce(p_donation_alerts, 'off') else 'off' end,
          case when p_donation_alerts = 'over' then p_donation_min end,
          case when v_admin and cardinality(p_donation_campaigns) > 0 then p_donation_campaigns end,
          case when v_admin then coalesce(p_donation_digest, 'off') else 'off' end,
          coalesce(p_task_alerts, 'both'), coalesce(p_payout_alerts, 'immediate'), coalesce(p_weekly_digests, true),
          coalesce(p_channels, '{}'), coalesce(p_message_alerts, 'immediate'), now())
  on conflict (org_id, user_id) do update set phone = excluded.phone, donation_alerts = excluded.donation_alerts,
    donation_min = excluded.donation_min, donation_campaigns = excluded.donation_campaigns, donation_digest = excluded.donation_digest,
    task_alerts = excluded.task_alerts, payout_alerts = excluded.payout_alerts, weekly_digests = excluded.weekly_digests,
    channels = excluded.channels, message_alerts = excluded.message_alerts, updated_at = excluded.updated_at;
end $$;

create or replace function public.notice_admins(p_org uuid)
returns table (user_id uuid, email text, name text, phone text, prefs public.notification_preferences)
language sql stable security definer set search_path = '' as $$
  select m.user_id, u.email, coalesce(nullif(trim(u.raw_user_meta_data ->> 'full_name'), ''), u.email), p.phone,
         coalesce(p, row(p_org, m.user_id, null, 'off', null, null, 'off', 'both', 'immediate', true, '{}'::jsonb, now(), 'immediate')::public.notification_preferences)
  from public.org_members m
  join auth.users u on u.id = m.user_id
  left join public.notification_preferences p on p.org_id = m.org_id and p.user_id = m.user_id
  where m.org_id = p_org and m.role in ('super_admin','admin') and m.status = 'active'
$$;

-- ---------------------------------------------------------------------------
-- Row-level security, logging and access
-- ---------------------------------------------------------------------------
alter table public.threads         enable row level security;
alter table public.thread_messages enable row level security;
alter table public.voice_notes     enable row level security;
alter table public.thread_reads    enable row level security;
alter table public.quick_replies   enable row level security;
alter table public.announcements   enable row level security;
alter table public.broadcasts      enable row level security;
revoke all on public.threads, public.thread_messages, public.voice_notes, public.thread_reads, public.quick_replies,
              public.announcements, public.broadcasts from anon;
revoke insert, update, delete on public.threads, public.thread_messages, public.voice_notes, public.thread_reads, public.quick_replies,
              public.announcements, public.broadcasts from authenticated;
revoke select on public.voice_notes, public.thread_reads from authenticated;

do $$
declare t text;
begin
  foreach t in array array['threads','thread_messages','quick_replies','announcements','broadcasts'] loop
    execute format('create policy org_wall on public.%I as restrictive for all to authenticated
                    using (org_id = (select public.current_org_id()))
                    with check (org_id = (select public.current_org_id()))', t);
  end loop;
end $$;
create policy see_thread on public.threads for select to authenticated using ((select public.can_see_thread(id)));
create policy see_message on public.thread_messages for select to authenticated using ((select public.can_see_thread(thread_id)));
create policy admin_read on public.quick_replies for select to authenticated using ((select public.is_admin()));
create policy active_read on public.announcements for select to authenticated using ((select public.is_active_user()));
create policy admin_read on public.broadcasts for select to authenticated using ((select public.is_admin()));

-- Messages are logged when written; the activity log is the permanent record the spec asks for.
create trigger log_row_change after insert on public.thread_messages for each row execute function public.log_row_change();
do $$
declare t text;
begin
  foreach t in array array['threads','quick_replies','announcements','broadcasts'] loop
    execute format('create trigger log_row_change after insert or update or delete on public.%I for each row execute function public.log_row_change()', t);
  end loop;
end $$;

do $$
declare f text;
begin
  foreach f in array array['notify_thread_message(uuid, uuid, uuid)', 'notify_message_digest(uuid)', 'run_notifications()', 'notice_admins(uuid)'] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
  foreach f in array array[
    'can_see_thread(uuid)', 'my_display_name()', 'my_threads()', 'unread_message_count()', 'open_direct_thread(text)',
    'set_group_chat(text, boolean)', 'mark_thread_read(uuid)', 'thread_history(uuid)', 'voice_note(uuid)',
    'post_message(uuid, text, text, text, integer)', 'send_broadcast(text, text, text[])', 'post_announcement(text)', 'remove_announcement()',
    'save_quick_reply(text, text, integer)', 'delete_quick_reply(text)',
    'save_notification_preferences(text, text, numeric, text[], text, text, text, boolean, jsonb, text)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
