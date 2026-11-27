-- A failed charge has no fee (Moshe Henig, 2026-11-10: a fee showed on a failed charge). The fee was worked out
-- from the payment method when the donation was saved, whatever its status, so a declined card on the payment
-- page, in the office or on a recurring retry got one. Now a donation that is (or becomes) failed keeps a fee of
-- zero, no manual fee and no net, however it was saved; totals already left failed gifts out, and now nothing
-- can add a fee for them either. Refunds, voids and returns keep theirs: those were real charges.

create or replace function public.failed_has_no_fee() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status = 'failed' then
    new.fee := 0;
    new.manual_fee := null;
    new.net_donation := 0;
  elsif tg_op = 'UPDATE' and old.status = 'failed' and new.net_donation = 0 and new.amount <> 0 then
    -- A failed gift marked completed after all (for example a duplicate result) gets its net back.
    new.net_donation := new.amount - coalesce(new.fee, 0);
  end if;
  return new;
end $$;

-- Named to run after donation_defaults, which works out the fee first.
drop trigger if exists zz_failed_has_no_fee on public.donations;
create trigger zz_failed_has_no_fee before insert or update on public.donations
  for each row execute function public.failed_has_no_fee();

-- Failed donations already saved with a fee.
update public.donations set fee = 0, manual_fee = null, net_donation = 0
where status = 'failed' and (coalesce(fee, 0) <> 0 or manual_fee is not null or coalesce(net_donation, 0) <> 0);

revoke execute on function public.failed_has_no_fee() from public, anon, authenticated;
