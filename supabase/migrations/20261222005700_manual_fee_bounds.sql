-- Readiness #16 (2026-11-15): a manual fee could be negative or more than the gift. It now runs from $0 to the
-- amount (a partial refund's own row has an amount below zero and a fee of 0, which stays allowed). Blank still
-- means "use the payment method's preset fee". No existing gift is outside this (checked on live data).
alter table public.donations drop constraint if exists donations_manual_fee_range;
alter table public.donations add constraint donations_manual_fee_range
  check (manual_fee is null or (manual_fee >= 0 and manual_fee <= greatest(amount, 0)));
