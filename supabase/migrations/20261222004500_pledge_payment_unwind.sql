-- Readiness #3 (approved 2026-11-15): a gift that's voided, refunded, returned, failed, rejected or deleted no longer
-- counts toward its pledge. Its pledge payments are removed (each removal is in the change log, with a note), so the
-- pledge and its installment reopen: their paid amounts and statuses are worked out from pledge payments. Bringing the
-- gift back doesn't re-add it; match it to the pledge again if needed. Existing payments on dead gifts are removed too.
create or replace function public.unwind_pledge_payments() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  if (old.status in ('completed', 'collect') and new.status not in ('completed', 'collect'))
     or (old.deleted_at is null and new.deleted_at is not null) then
    for r in delete from public.pledge_payments where org_id = new.org_id and donation_id = new.id returning pledge_id, amount loop
      perform public.write_activity(new.org_id, 'pledge_payment_removed', 'pledges', r.pledge_id, new.campaign_id,
        jsonb_build_object('donation', new.id, 'amount', r.amount, 'because', coalesce(case when new.deleted_at is not null then 'deleted' end, new.status)));
    end loop;
  end if;
  return null;
end $$;
revoke execute on function public.unwind_pledge_payments() from public, anon, authenticated;
drop trigger if exists unwind_pledge_payments on public.donations;
create trigger unwind_pledge_payments after update of status, deleted_at on public.donations
  for each row execute function public.unwind_pledge_payments();

delete from public.pledge_payments pp using public.donations d
where d.org_id = pp.org_id and d.id = pp.donation_id and (d.status not in ('completed', 'collect') or d.deleted_at is not null);
