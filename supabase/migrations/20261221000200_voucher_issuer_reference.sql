-- Vouchers (Moshe Henig, 2026-11-11): a separate field for the issuer's reference number, apart from our voucher
-- ref # (VCH-...), which the form now shows on saving so staff can match it to the physical voucher.

alter table public.vouchers add column if not exists issuer_reference text;

-- The list view, unchanged except for the new column at the end.
create or replace view public.voucher_list with (security_invoker = true) as
 SELECT v.id,
    v.org_id,
    v.campaign_id,
    v.donor_id,
    v.name,
    v.issuer,
    v.issuer_number,
    v.submission,
    v.account_number,
    v.face_value,
    v.fee_type,
    v.fee_percent,
    v.fee_flat,
    v.date_received,
    v.expected_date,
    v.notes,
    v.overage_flag,
    v.cancelled_at,
    v.cancel_reason,
    v.created_by,
    v.created_at,
    v.updated_at,
    v.deleted_at,
    v.deleted_by,
    COALESCE(f.funded, (0)::numeric) AS total_funded,
    COALESCE(f.fees, (0)::numeric) AS total_fees,
    COALESCE(f.net, (0)::numeric) AS total_net,
        CASE
            WHEN (v.cancelled_at IS NOT NULL) THEN (0)::numeric
            ELSE (v.face_value - COALESCE(f.funded, (0)::numeric))
        END AS remaining,
    round(((COALESCE(f.funded, (0)::numeric) / v.face_value) * (100)::numeric), 1) AS percent_funded,
        CASE
            WHEN (v.cancelled_at IS NOT NULL) THEN 'cancelled'::text
            WHEN v.overage_flag THEN 'overage_review'::text
            WHEN (COALESCE(f.funded, (0)::numeric) >= v.face_value) THEN 'funded'::text
            WHEN (COALESCE(f.funded, (0)::numeric) > (0)::numeric) THEN 'partial'::text
            ELSE 'pending'::text
        END AS status,
    ((v.cancelled_at IS NULL) AND (COALESCE(f.funded, (0)::numeric) < v.face_value) AND ((v.expected_date < CURRENT_DATE) OR ((v.expected_date IS NULL) AND (v.date_received <= (CURRENT_DATE - 30))))) AS overdue,
    COALESCE(dn.display_name, v.name) AS donor_name,
    c.internal_name AS campaign_internal,
    c.external_name AS campaign_external,
    v.issuer_reference
   FROM (((vouchers v
     LEFT JOIN LATERAL ( SELECT sum(d.amount) AS funded,
            sum(COALESCE(d.fee, (0)::numeric)) AS fees,
            sum(d.net_donation) AS net
           FROM donations d
          WHERE ((d.org_id = v.org_id) AND (d.voucher_id = v.id) AND (d.deleted_at IS NULL) AND (d.status = ANY (ARRAY['completed'::text, 'collect'::text])))) f ON (true))
     LEFT JOIN donors dn ON (((dn.org_id = v.org_id) AND (dn.id = v.donor_id))))
     LEFT JOIN campaigns c ON (((c.org_id = v.org_id) AND (c.id = v.campaign_id))))
  WHERE (v.deleted_at IS NULL);
