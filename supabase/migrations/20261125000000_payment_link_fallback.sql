-- A campaign's Payment Link is used only when it is a web address. Anything else typed there (a number, a
-- note) used to be shared as if it were the link; now the campaign's own payment page is shared instead.

create or replace function public.campaign_payment_url(p_org uuid, p_campaign text) returns text
language sql stable security definer set search_path = '' as $$
  select case when trim(c.payment_link) ~* '^https?://\S+$' then trim(c.payment_link) else public.give_url(c.org_id, c.id) end
  from public.campaigns c where c.org_id = p_org and c.id = p_campaign
$$;

create or replace function public.share_template(p_org uuid, p_campaign text, p_channel text) returns text
language sql stable security definer set search_path = '' as $$
  select array_to_string(array_remove(array[
           case p_channel when 'sms' then public.campaign_payment_url(p_org, p_campaign) else 'Donate here: ' || public.campaign_payment_url(p_org, p_campaign) end,
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
  if public.campaign_payment_url(v_org, p_campaign) is null then raise exception 'This campaign has no payment link yet'; end if;
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

revoke execute on function public.campaign_payment_url(uuid, text) from public, anon, authenticated;
