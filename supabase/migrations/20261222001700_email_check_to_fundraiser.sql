-- "Email to fundraiser" for checks (Moshe Henig, 2026-11-11): the check's PDF goes by email to the campaign's primary
-- fundraiser. It completes the check like printing does (clears its "Check Not Printed" task); either can still be
-- done afterwards. A one-message attachment table carries the PDF to the sender, beside outreach attachments.

create table if not exists public.message_attachments (
  org_id     uuid not null references public.organizations(id),
  message_id uuid not null,
  name       text not null,
  content    text not null,          -- base64
  created_at timestamptz not null default now(),
  primary key (org_id, message_id)
);
alter table public.message_attachments enable row level security;
revoke all on public.message_attachments from public, anon, authenticated;

alter table public.checks add column if not exists emailed_at timestamptz;
alter table public.checks add column if not exists emailed_to text;
alter table public.checks add column if not exists emailed_by text;

create or replace function public.claim_messages(p_limit integer default 50)
returns table (org_id uuid, id uuid, channel text, to_address text, to_name text, subject text, body text, html text, kind text, from_name text,
  from_email text, reply_to text, sms_from text, unsubscribe_url text, attachment_name text, attachment text)
language sql security definer set search_path = '' as $function$
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
         coalesce(x.attachment_name, ma.name), coalesce(x.attachment, ma.content)
  from taken t
  join public.organizations o on o.id = t.org_id
  left join public.messaging_settings s on s.org_id = t.org_id
  left join public.outreach_sends x on t.kind = 'outreach' and x.org_id = t.org_id and x.id::text = t.record_id and x.attachment is not null
  left join public.message_attachments ma on ma.org_id = t.org_id and ma.message_id = t.id
$function$;

create or replace function public.email_check_to_fundraiser(p_check text, p_pdf_base64 text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id(); k public.checks; e public.expenses; m public.managers; v_org_name text; v_msg uuid;
begin
  perform public.require_admin();
  select * into k from public.checks where org_id = v_org and id = p_check;
  if k.id is null then raise exception 'Check not found'; end if;
  if k.status not in ('outstanding','cleared') then raise exception 'A % check can''t be emailed', k.status; end if;
  if p_pdf_base64 is null or length(p_pdf_base64) < 100 or length(p_pdf_base64) > 8000000 then raise exception 'The check PDF is missing'; end if;
  select * into e from public.expenses where org_id = v_org and id = k.expense_id;
  select mg.* into m from public.campaigns c join public.managers mg on mg.org_id = c.org_id and mg.id = c.manager_id
  where c.org_id = v_org and c.id = e.campaign_id and mg.deleted_at is null;
  if m.id is null then raise exception 'This check''s campaign has no primary fundraiser to email'; end if;
  if nullif(trim(m.email), '') is null then raise exception '% has no email address on file', coalesce(m.full_name, 'The fundraiser'); end if;
  select name into v_org_name from public.organizations where id = v_org;
  v_msg := public.queue_message(v_org, 'email', trim(m.email), m.full_name,
    format('Check #%s to %s from %s', k.check_number, k.payee, v_org_name),
    format('Attached is check #%s to %s for $%s (campaign %s). Print it on check stock to use it.', k.check_number, k.payee, to_char(k.amount, 'FM999,999,990.00'), e.campaign_id),
    null, 'check', k.id, null, e.campaign_id, null);
  insert into public.message_attachments (org_id, message_id, name, content) values (v_org, v_msg, format('check-%s.pdf', k.check_number), p_pdf_base64);
  update public.checks set emailed_at = now(), emailed_to = trim(m.email), emailed_by = public.current_email() where org_id = v_org and id = k.id;
  update public.task_items set resolved_at = now() where org_id = v_org and task_key = 'check_unprinted:' || k.id and resolved_at is null;
  perform public.write_activity(v_org, 'email_check', 'checks', k.id, e.campaign_id, jsonb_build_object('check_number', k.check_number, 'to', trim(m.email)));
  return jsonb_build_object('to', trim(m.email), 'name', m.full_name, 'message_id', v_msg);
end $$;
revoke execute on function public.email_check_to_fundraiser(text, text) from public, anon;
grant execute on function public.email_check_to_fundraiser(text, text) to authenticated;

create or replace view public.check_register with (security_invoker = true) as
SELECT k.id,
    k.org_id,
    k.account_id,
    k.check_number,
    k.expense_id,
    k.payee,
    k.amount,
    k.memo,
    k.check_date,
    k.status,
    k.status_reason,
    k.status_by,
    k.status_at,
    k.issued_by,
    k.issued_at,
    a.name AS account_name,
    e.campaign_id,
    c.internal_name AS campaign_name,
    e.payee_id,
        CASE
            WHEN (k.status = 'outstanding'::text) THEN (org_today() - k.check_date)
            ELSE NULL::integer
        END AS days_outstanding,
    k.printed_at,
    k.printed_by,
    k.emailed_at,
    k.emailed_to
   FROM (((checks k
     JOIN accounts a ON (((a.org_id = k.org_id) AND (a.id = k.account_id))))
     LEFT JOIN expenses e ON (((e.org_id = k.org_id) AND (e.id = k.expense_id))))
     LEFT JOIN campaigns c ON (((c.org_id = e.org_id) AND (c.id = e.campaign_id))));
