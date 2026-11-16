-- Campaigns list was slow (Moshe Henig, 2026-11-16): campaign_summary took ~0.5 s, ~0.42 s of it adding up the
-- donations per campaign, where each of ten sums re-tested every row (status, "is it an undelivered check?" with a
-- text match on the payment method). Each row's flags are now worked out once and the sums use them: the same
-- numbers (checked against the old version on the live data), in about half the time. Everything else in the view
-- is the live definition unchanged.
create or replace view public.campaign_summary with (security_invoker = true) as
WITH RECURSIVE walk AS (
         SELECT c.org_id,
            c.id,
            c.parent_campaign_id AS up
           FROM campaigns c
          WHERE ((c.balance_mode = 'shared'::text) AND (c.deleted_at IS NULL))
        UNION ALL
         SELECT w.org_id,
            w.id,
            p.parent_campaign_id
           FROM (walk w
             JOIN campaigns p ON (((p.org_id = w.org_id) AND (p.id = w.up))))
          WHERE (p.balance_mode = 'shared'::text)
        ), pool AS (
         SELECT w.org_id,
            w.id,
            w.up AS pool_id
           FROM walk w
          WHERE (NOT (EXISTS ( SELECT 1
                   FROM campaigns p
                  WHERE ((p.org_id = w.org_id) AND (p.id = w.up) AND (p.balance_mode = 'shared'::text)))))
        ), d AS (
         -- Each row's flags worked out once, then summed (the same sums as before, about twice as fast).
         SELECT x.org_id,
            x.campaign_id,
            COALESCE(sum(x.raised_part) FILTER (WHERE x.counted), (0)::numeric) AS donations_raised,
            COALESCE(sum(x.fee) FILTER (WHERE x.fee_counts AND NOT x.und), (0)::numeric) AS fees,
            COALESCE(sum(x.batch_pending) FILTER (WHERE x.live), (0)::numeric) AS pending_balance,
            count(*) FILTER (WHERE x.fee_counts AND NOT x.und) AS donation_count,
            sum(x.amount) FILTER (WHERE x.und) AS undelivered_checks_amount,
            count(*) FILTER (WHERE x.und) AS undelivered_checks_count,
            max(x.created_at) FILTER (WHERE x.status <> 'failed'::text) AS last_donation_at,
            COALESCE(sum(x.amount) FILTER (WHERE x.status = 'post_dated'::text), (0)::numeric) AS post_dated_amount,
            COALESCE(sum(x.amount) FILTER (WHERE x.status = 'pending'::text), (0)::numeric) AS awaiting_approval
           FROM ( SELECT dn.org_id, dn.campaign_id, dn.status, dn.amount, dn.fee, dn.batch_pending, dn.created_at,
                    CASE WHEN dn.type = 'Payment'::text THEN dn.amount ELSE dn.funded END AS raised_part,
                    ((dn.status = 'completed'::text) AND (dn.delivered = false) AND (dn.payment_method ~~* '%check%'::text)) IS TRUE AS und,
                    ((dn.status = 'completed'::text) AND NOT COALESCE(((dn.delivered = false) AND (dn.payment_method ~~* '%check%'::text)), false)) AS counted,
                    (dn.status = ANY (ARRAY['completed'::text, 'collect'::text, 'refunded'::text, 'returned'::text])) AS fee_counts,
                    (dn.status = ANY (ARRAY['completed'::text, 'collect'::text])) AS live
                   FROM donations dn
                  WHERE (dn.deleted_at IS NULL)
                 OFFSET 0) x
          GROUP BY x.org_id, x.campaign_id
        ), e AS (
         SELECT campaign_expense_totals.org_id,
            campaign_expense_totals.campaign_id,
            campaign_expense_totals.expenses
           FROM campaign_expense_totals() campaign_expense_totals(org_id, campaign_id, expenses)
        ), t AS (
         SELECT campaign_transfer_totals.org_id,
            campaign_transfer_totals.campaign_id,
            campaign_transfer_totals.amount_in,
            campaign_transfer_totals.amount_out
           FROM campaign_transfer_totals() campaign_transfer_totals(org_id, campaign_id, amount_in, amount_out)
        ), vf AS (
         SELECT donations.org_id,
            donations.voucher_id,
            sum(donations.amount) AS funded
           FROM donations
          WHERE ((donations.voucher_id IS NOT NULL) AND (donations.deleted_at IS NULL) AND (donations.status = ANY (ARRAY['completed'::text, 'collect'::text])))
          GROUP BY donations.org_id, donations.voucher_id
        ), v AS (
         SELECT v.org_id,
            v.campaign_id,
            sum(GREATEST((v.face_value - COALESCE(vf.funded, (0)::numeric)), (0)::numeric)) AS awaiting_funds
           FROM (vouchers v
             LEFT JOIN vf ON (((vf.org_id = v.org_id) AND (vf.voucher_id = v.id))))
          WHERE ((v.deleted_at IS NULL) AND (v.cancelled_at IS NULL))
          GROUP BY v.org_id, v.campaign_id
        ), pr AS (
         SELECT pledge_payments.org_id,
            pledge_payments.pledge_id,
            sum(pledge_payments.amount) AS received
           FROM pledge_payments
          GROUP BY pledge_payments.org_id, pledge_payments.pledge_id
        ), pl AS (
         SELECT p.org_id,
            p.campaign_id,
            sum(GREATEST((p.amount - COALESCE(pr.received, (0)::numeric)), (0)::numeric)) AS pledged_open
           FROM (pledges p
             LEFT JOIN pr ON (((pr.org_id = p.org_id) AND (pr.pledge_id = p.id))))
          WHERE ((p.deleted_at IS NULL) AND (p.cancelled_at IS NULL))
          GROUP BY p.org_id, p.campaign_id
        ), ip AS (
         SELECT pledge_payments.org_id,
            pledge_payments.installment_id,
            sum(pledge_payments.amount) AS paid
           FROM pledge_payments
          WHERE (pledge_payments.installment_id IS NOT NULL)
          GROUP BY pledge_payments.org_id, pledge_payments.installment_id
        ), sch AS (
         SELECT p.org_id,
            p.campaign_id,
            sum(GREATEST((i.amount - COALESCE(ip.paid, (0)::numeric)), (0)::numeric)) FILTER (WHERE (i.due_date <= (org_today() + 30))) AS next_30,
            sum(GREATEST((i.amount - COALESCE(ip.paid, (0)::numeric)), (0)::numeric)) AS next_90
           FROM ((pledge_installments i
             JOIN pledges p ON (((p.org_id = i.org_id) AND (p.id = i.pledge_id))))
             LEFT JOIN ip ON (((ip.org_id = i.org_id) AND (ip.installment_id = i.id))))
          WHERE ((NOT i.skipped) AND (NOT i.cancelled) AND (p.deleted_at IS NULL) AND (p.cancelled_at IS NULL) AND (i.due_date >= org_today()) AND (i.due_date <= (org_today() + 90)))
          GROUP BY p.org_id, p.campaign_id
        ), own AS (
         SELECT c.id,
            c.campaign_name,
            c.external_name,
            c.internal_name,
            c.manager_id,
            c.sub_manager_ids,
            c.email,
            c.phone,
            c.payment_link,
            c.notes,
            c.exchange,
            c.pin,
            c.archived_at,
            c.created_by,
            c.created_at,
            c.updated_at,
            c.deleted_at,
            c.deleted_by,
            c.org_id,
            c.status,
            c.featured,
            c.closed_at,
            c.parent_campaign_id,
            c.balance_mode,
            c.sub_slug,
            c.goal,
            c.account_id,
            m.full_name AS manager_name,
            (COALESCE(d.donations_raised, (0)::numeric) + COALESCE(t.amount_in, (0)::numeric)) AS raised,
            COALESCE(d.fees, (0)::numeric) AS fees,
                CASE
                    WHEN ((COALESCE(d.donations_raised, (0)::numeric) + COALESCE(t.amount_in, (0)::numeric)) = (0)::numeric) THEN (0)::numeric
                    ELSE (COALESCE(d.fees, (0)::numeric) / (COALESCE(d.donations_raised, (0)::numeric) + COALESCE(t.amount_in, (0)::numeric)))
                END AS fee_percent,
            (COALESCE(e.expenses, (0)::numeric) + COALESCE(t.amount_out, (0)::numeric)) AS expenses,
            ((((COALESCE(d.donations_raised, (0)::numeric) + COALESCE(t.amount_in, (0)::numeric)) - COALESCE(d.fees, (0)::numeric)) - COALESCE(e.expenses, (0)::numeric)) - COALESCE(t.amount_out, (0)::numeric)) AS own_balance,
            COALESCE(d.pending_balance, (0)::numeric) AS pending_balance,
            COALESCE(d.donation_count, (0)::bigint) AS donation_count,
            d.last_donation_at,
            COALESCE(d.post_dated_amount, (0)::numeric) AS post_dated_amount,
            COALESCE(d.undelivered_checks_amount, (0)::numeric) AS undelivered_checks_amount,
            COALESCE(d.undelivered_checks_count, (0)::bigint) AS undelivered_checks_count,
            COALESCE(d.awaiting_approval, (0)::numeric) AS awaiting_approval,
            COALESCE(v.awaiting_funds, (0)::numeric) AS awaiting_funds,
            COALESCE(pl.pledged_open, (0)::numeric) AS pledged_open,
            COALESCE(sch.next_30, (0)::numeric) AS pledge_scheduled_30,
            COALESCE(sch.next_90, (0)::numeric) AS pledge_scheduled_90,
            pool.pool_id
           FROM ((((((((campaigns c
             LEFT JOIN managers m ON (((m.org_id = c.org_id) AND (m.id = c.manager_id) AND (m.deleted_at IS NULL))))
             LEFT JOIN d ON (((d.org_id = c.org_id) AND (d.campaign_id = c.id))))
             LEFT JOIN e ON (((e.org_id = c.org_id) AND (e.campaign_id = c.id))))
             LEFT JOIN t ON (((t.org_id = c.org_id) AND (t.campaign_id = c.id))))
             LEFT JOIN v ON (((v.org_id = c.org_id) AND (v.campaign_id = c.id))))
             LEFT JOIN pl ON (((pl.org_id = c.org_id) AND (pl.campaign_id = c.id))))
             LEFT JOIN sch ON (((sch.org_id = c.org_id) AND (sch.campaign_id = c.id))))
             LEFT JOIN pool ON (((pool.org_id = c.org_id) AND (pool.id = c.id))))
          WHERE (c.deleted_at IS NULL)
        ), rollup AS (
         SELECT own.org_id,
            COALESCE(own.pool_id, own.id) AS id,
            sum(own.raised) AS raised,
            sum(own.fees) AS fees,
            sum(own.expenses) AS expenses,
            sum(own.own_balance) AS balance,
            sum(own.donation_count) AS donations
           FROM own
          GROUP BY own.org_id, COALESCE(own.pool_id, own.id)
        ), kids AS (
         SELECT own.org_id,
            own.parent_campaign_id AS id,
            count(*) AS sub_count
           FROM own
          WHERE (own.parent_campaign_id IS NOT NULL)
          GROUP BY own.org_id, own.parent_campaign_id
        )
 SELECT o.id,
    o.campaign_name,
    o.external_name,
    o.internal_name,
    o.manager_id,
    o.sub_manager_ids,
    o.email,
    o.phone,
    o.payment_link,
    o.notes,
    o.exchange,
    o.pin,
    o.archived_at,
    o.created_by,
    o.created_at,
    o.updated_at,
    o.deleted_at,
    o.deleted_by,
    o.org_id,
    o.status,
    o.featured,
    o.closed_at,
    o.parent_campaign_id,
    o.balance_mode,
    o.sub_slug,
    o.goal,
    o.account_id,
    o.manager_name,
    o.raised,
    o.fees,
    o.fee_percent,
    o.expenses,
    o.own_balance,
    o.pending_balance,
    o.donation_count,
    o.last_donation_at,
    o.post_dated_amount,
    o.awaiting_approval,
    o.awaiting_funds,
    o.pledged_open,
    o.pledge_scheduled_30,
    o.pledge_scheduled_90,
    o.pool_id,
        CASE
            WHEN (o.pool_id IS NOT NULL) THEN (0)::numeric
            ELSE r.balance
        END AS balance,
    COALESCE(r.raised, o.raised) AS combined_raised,
    COALESCE(r.fees, o.fees) AS combined_fees,
    COALESCE(r.expenses, o.expenses) AS combined_expenses,
    COALESCE(r.donations, (o.donation_count)::numeric) AS combined_donations,
    COALESCE(k.sub_count, (0)::bigint) AS sub_count,
    o.undelivered_checks_amount,
    o.undelivered_checks_count
   FROM ((own o
     LEFT JOIN rollup r ON (((r.org_id = o.org_id) AND (r.id = o.id))))
     LEFT JOIN kids k ON (((k.org_id = o.org_id) AND (k.id = o.id))));
