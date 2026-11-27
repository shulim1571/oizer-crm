-- Readiness #15 (2026-11-15): Reports showed fees out of line with the fee rules, by source.
--
-- What was behind it (live data, 2026-11-16):
--   * Card gifts at $0 under imported Donary machine sources ("Oizer #3", "#4", "#7", "#9") and Cartis: their method
--     is an imported name ("Credit Card VISA", "usaepay") that matches no payment method, so no fee was worked out.
--     Those are flagged on the Task Sheet per method name (readiness #14) for an admin to map or add.
--   * Five card gifts taken in the app on Nov 3-4 (sandbox, test card ending 1111: three on the payment page, one
--     admin charge, one recurring charge) were saved with a fee of $0, before the card rate applied to them; a gift
--     with a processor reference isn't recalculated on edit, so they stayed at $0. Corrected here to what the fee
--     rules give ($0.31 on each $5, $2.73 on $100, $2.86 on $105).
--   * A $0.57 fee on a $100 cash gift: entered by hand (a manual fee), which the rules allow. Left as it is.
--
-- The correction: completed card gifts taken in the app (a processor reference, source Online or Manual) with no
-- manual fee and a fee of exactly 0 get the fee their rules give, when that is more than 0. Each change goes to
-- the activity log like any other.
update public.donations d
   set fee = f.fee, net_donation = d.amount - f.fee
  from (
    select d2.org_id, d2.id,
           public.calculate_fee(d2.org_id, d2.campaign_id, d2.payment_method, d2.amount,
                                public.fee_processor(d2.source, d2.donary_id, d2.gateway_id)) as fee
    from public.donations d2
    where d2.status = 'completed' and d2.deleted_at is null and d2.fee = 0 and d2.manual_fee is null
      and d2.gateway_id is not null and d2.source in ('Online', 'Manual') and d2.payment_method is not null
  ) f
 where d.org_id = f.org_id and d.id = f.id and f.fee > 0;
