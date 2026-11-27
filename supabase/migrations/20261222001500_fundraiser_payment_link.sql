-- Each fundraiser can have their own payment link, set in Outreach (Moshe Henig, 2026-11-11), and messages can use
-- {payment_link}: a fundraiser gets their own link; a donor messaged about a campaign gets the link of that campaign's
-- primary fundraiser (blank when there's none). Otherwise send_outreach is unchanged.

alter table public.managers add column if not exists payment_link text
  check (payment_link is null or payment_link ~* '^https?://[^\s]+$');

create or replace function public.send_outreach(p_channel text, p_subject text, p_body text, p_sms_body text, p_recipients jsonb,
  p_send_after timestamptz default null, p_attachment_name text default null, p_attachment text default null) returns jsonb
language plpgsql security definer set search_path = '' as $function$
declare
  v_org uuid := public.current_org_id();
  v_id uuid;
  r jsonb;
  v_link text; v_first text; v_last text; v_name text; v_email text; v_phone text; v_campaign text; v_donor text;
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
    v_link := null; v_first := null; v_last := null; v_name := null; v_email := null; v_phone := null; v_donor := null;
    v_campaign := nullif(r ->> 'campaign_id', '');
    if r ->> 'kind' = 'donor' then
      select dn.first_name, dn.last_name, dn.display_name, dn.email, dn.phone, dn.id into v_first, v_last, v_name, v_email, v_phone, v_donor
      from public.donors dn where dn.org_id = v_org and dn.id = r ->> 'id' and dn.deleted_at is null;
      -- {payment_link} for a donor: the payment link of the campaign's primary fundraiser.
      select m.payment_link into v_link from public.campaigns c join public.managers m on m.org_id = c.org_id and m.id = c.manager_id
      where c.org_id = v_org and c.id = v_campaign;
    elsif r ->> 'kind' = 'fundraiser' then
      select m.first_name, m.last_name, m.full_name, m.email, m.phone, m.payment_link into v_first, v_last, v_name, v_email, v_phone, v_link
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
            replace(public.personalize(p_subject, v_first, v_last, v_campaign), '{payment_link}', coalesce(v_link, '')),
            replace(public.personalize(p_body, v_first, v_last, v_campaign), '{payment_link}', coalesce(v_link, '')),
            public.marketing_html(v_org, null, public.format_message_html(replace(public.personalize(p_body, v_first, v_last, v_campaign), '{payment_link}', coalesce(v_link, '')))),
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
        v_sms := replace(public.personalize(p_sms_body, v_first, v_last, v_campaign), '{payment_link}', coalesce(v_link, '')) || E'\nReply STOP to opt out.';
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
end $function$;
