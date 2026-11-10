-- A "Receipt Requested" item leaves the Task Sheet once the receipt is sent (Moshe Henig's report, 2026-11-10).
-- Before, only the Task Sheet's own send dialog took it off, and only if its follow-up call finished before the
-- sheet reloaded; a receipt sent from the donation, the Receipts page or automatically left the request open.
-- Now sending a receipt by email or text, from anywhere, closes any open request for the donations it covers.
-- Messages held in test mode count as sent, as everywhere else on the sheet.

create or replace function public.close_receipt_requests() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.kind = 'receipt' and new.record_id is not null then
    update public.task_items i set resolved_at = now()
    from public.receipts r
    where r.org_id = new.org_id and r.id = new.record_id and r.status = 'issued'
      and i.org_id = r.org_id and i.task_type = 'receipt_requested' and i.resolved_at is null
      and i.record_id = any(r.donation_ids || r.donation_id);
  end if;
  return null;
end $$;

drop trigger if exists close_receipt_requests on public.messages;
create trigger close_receipt_requests after insert on public.messages
  for each row execute function public.close_receipt_requests();

revoke execute on function public.close_receipt_requests() from public, anon, authenticated;

-- Requests already handled before this change: the receipt went out, but the request stayed open.
update public.task_items i set resolved_at = now()
where i.task_type = 'receipt_requested' and i.resolved_at is null
  and exists (
    select 1 from public.receipts r
    join public.messages m on m.org_id = r.org_id and m.kind = 'receipt' and m.record_id = r.id
    where r.org_id = i.org_id and r.status = 'issued' and i.record_id = any(r.donation_ids || r.donation_id));
