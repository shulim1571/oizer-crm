-- Every failed recurring charge goes on the Task Sheet, not only the third (Moshe Henig, 2026-11-10: a charge failed,
-- the email came, but the sheet had nothing). The item names the donor, amount, schedule, which failure it is, the
-- reason and when it's tried again (or that it's paused). It leaves the sheet once the charge goes through, or the
-- office retries, resumes, cancels or the schedule ends; a retry that fails again puts it back.

create or replace function public.recurring_failed_summary(r public.recurring_donations) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((select d.display_name from public.donors d where d.org_id = r.org_id and d.id = r.donor_id), 'A donor')
    || ': ' || public.money_text(r.amount) || ' each ' || public.frequency_label(r.frequency)
    || ' to ' || public.campaign_label(r.org_id, r.campaign_id)
    || ' · failed ' || case r.failures when 1 then 'once' when 2 then 'twice' else r.failures || ' times' end
    || ' (' || coalesce(r.last_error, 'declined') || ')'
    || case when r.status = 'paused' then ' · paused until the card is updated or it''s retried'
            when r.retry_on is not null then ' · tried again ' || to_char(r.retry_on, 'FMMon FMDD')
            else '' end
$$;

-- The fundraisers on the schedule's campaign hear about every failure (Moshe Henig: "the fundraiser it's assigned
-- to should also get an email"). notify_recurring_failure already tells admins and the team on the first failure
-- and when it pauses; this covers the ones in between, for the team only (admins have it on the Task Sheet).
-- Each fundraiser's own notification setting still applies; no fundraiser, or no address, means no message.
create or replace function public.notify_recurring_failure_team(p_org uuid, p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.recurring_donations; t record; v_name text; v_lines text[];
begin
  select * into r from public.recurring_donations where org_id = p_org and id = p_id;
  if r.id is null then return; end if;
  select d.display_name into v_name from public.donors d where d.org_id = p_org and d.id = r.donor_id;
  v_lines := array[
    public.html_escape(coalesce(v_name, 'A donor')) || ': <b>' || public.money_text(r.amount) || '</b> each ' || public.frequency_label(r.frequency)
      || ' to ' || public.html_escape(public.campaign_label(p_org, r.campaign_id)),
    'Reason: ' || public.html_escape(coalesce(r.last_error, 'not given')) || ' (failed ' || r.failures || ' times)',
    case when r.retry_on is not null then 'It will be tried again on ' || to_char(r.retry_on, 'FMMonth FMDD') || '.' else 'The office has it on the Task Sheet.' end];
  for t in select * from public.notice_team(p_org, r.campaign_id, 'donations') loop
    perform public.notify_person(p_org, t.email, t.phone, t.name, t.channel, 'recurring_failed', 'A recurring charge failed again', v_lines,
      null, null, r.id::text, r.campaign_id, r.donor_id);
  end loop;
end $$;

create or replace function public.recurring_failed_task() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.failures > coalesce(old.failures, 0) then
    insert into public.task_items (org_id, task_key, task_type, record_id, campaign_id, amount, summary)
    values (new.org_id, 'recurring_failed:' || new.id, 'recurring_failed', new.id::text, new.campaign_id, new.amount,
            public.recurring_failed_summary(new))
    on conflict (org_id, task_key) do update set summary = excluded.summary, amount = excluded.amount, created_at = now(), resolved_at = null;
    -- The first failure and a pause already email admins and the team; the ones between reach the team here.
    if new.failures > 1 and new.status <> 'paused' then perform public.notify_recurring_failure_team(new.org_id, new.id); end if;
  elsif (new.failures = 0 and old.failures > 0) or (new.status in ('cancelled','completed') and old.status not in ('cancelled','completed')) then
    update public.task_items set resolved_at = now()
    where org_id = new.org_id and task_key = 'recurring_failed:' || new.id and resolved_at is null;
  end if;
  return null;
end $$;

drop trigger if exists recurring_failed_task on public.recurring_donations;
create trigger recurring_failed_task after update of failures, status on public.recurring_donations
  for each row execute function public.recurring_failed_task();

-- The payment-result function still writes its own wording when a schedule pauses; keep the fuller one.
create or replace function public.recurring_failed_task_wording() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r public.recurring_donations;
begin
  if new.task_type = 'recurring_failed' and new.resolved_at is null then
    select * into r from public.recurring_donations where org_id = new.org_id and id::text = new.record_id;
    if r.id is not null and r.failures > 0 then new.summary := public.recurring_failed_summary(r); end if;
  end if;
  return new;
end $$;
drop trigger if exists recurring_failed_task_wording on public.task_items;
create trigger recurring_failed_task_wording before insert or update on public.task_items
  for each row execute function public.recurring_failed_task_wording();

-- Schedules already failing (failures > 0, not ended) get their item now.
insert into public.task_items (org_id, task_key, task_type, record_id, campaign_id, amount, summary)
select r.org_id, 'recurring_failed:' || r.id, 'recurring_failed', r.id::text, r.campaign_id, r.amount, public.recurring_failed_summary(r)
from public.recurring_donations r
where r.failures > 0 and r.status not in ('cancelled','completed')
on conflict (org_id, task_key) do nothing;  -- an item the office already took off stays off

revoke execute on function public.recurring_failed_summary(public.recurring_donations) from public, anon, authenticated;
revoke execute on function public.recurring_failed_task() from public, anon, authenticated;
revoke execute on function public.notify_recurring_failure_team(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.recurring_failed_task_wording() from public, anon, authenticated;
