-- Readiness #61 (2026-11-15): "Expenses out" on the bank accounts list could be negative (Fidelity -160,613.30)
-- because imported history records money coming back to an account as payouts below zero, netted in with the rest.
-- Two columns are added: payouts_out (what left the account, always positive) and returned_in (what came back that
-- way). expenses_total stays (it's their difference), so nothing reading it changes.
create or replace view public.account_summary with (security_invoker = true) as
 SELECT a.id, a.name, a.filter_checks, a.notes, a.created_at, a.deleted_at, a.deleted_by, a.org_id,
    COALESCE(d.donation_count, (0)::bigint) AS donation_count,
    COALESCE(d.donations_total, (0)::numeric) AS donations_total,
    COALESCE(e.expense_count, (0)::bigint) AS expense_count,
    COALESCE(e.expenses_total, (0)::numeric) AS expenses_total,
    COALESCE(e.uncleared_total, (0)::numeric) AS uncleared_total,
    COALESCE(e.payouts_out, (0)::numeric) AS payouts_out,
    COALESCE(e.returned_in, (0)::numeric) AS returned_in
   FROM ((accounts a
     LEFT JOIN ( SELECT donations.org_id, donations.account_id, count(*) AS donation_count, sum(donations.amount) AS donations_total
           FROM donations
          WHERE ((donations.status = ANY (ARRAY['completed'::text, 'collect'::text])) AND (donations.deleted_at IS NULL))
          GROUP BY donations.org_id, donations.account_id) d ON (((d.org_id = a.org_id) AND (d.account_id = a.id))))
     LEFT JOIN ( SELECT expenses.org_id, expenses.account_id, count(*) AS expense_count, sum(expenses.amount) AS expenses_total,
            sum(expenses.amount) FILTER (WHERE ((expenses.method = 'Check'::text) AND (expenses.cleared IS NOT TRUE))) AS uncleared_total,
            sum(expenses.amount) FILTER (WHERE expenses.amount > 0) AS payouts_out,
            -sum(expenses.amount) FILTER (WHERE expenses.amount < 0) AS returned_in
           FROM expenses
          WHERE (expenses.deleted_at IS NULL)
          GROUP BY expenses.org_id, expenses.account_id) e ON (((e.org_id = a.org_id) AND (e.account_id = a.id))))
  WHERE (a.deleted_at IS NULL);
