-- Moshe #11 (approved 2026-11-15): Total potential keeps its formula (raised + open pledges + pending + checks not
-- delivered), and a parent's figure includes its teams' amounts the same way "Raised, with teams" already does.
-- campaign_summary gains the team-inclusive pledged, pending and undelivered-check figures (added at the end, so
-- nothing that reads the view changes). Teams are the campaigns that share the parent's balance; sub-campaigns that
-- keep their own balance are counted on their own page, as for raised.
do $$
declare v_def text; v_new text; v_opts text;
begin
  v_def := pg_get_viewdef('public.campaign_summary'::regclass);
  v_new := replace(v_def, $s$sum(own.donation_count) AS donations
           FROM own$s$, $s$sum(own.donation_count) AS donations,
            sum(own.pledged_open) AS pledged_open,
            sum(own.pending_balance) AS pending_balance,
            sum(own.undelivered_checks_amount) AS undelivered_checks_amount
           FROM own$s$);
  if v_new = v_def then raise exception 'campaign_summary: rollup not found'; end if;
  v_def := v_new;
  v_new := replace(v_def, $s$o.undelivered_checks_count
   FROM ((own o$s$, $s$o.undelivered_checks_count,
    COALESCE(r.pledged_open, o.pledged_open) AS combined_pledged_open,
    COALESCE(r.pending_balance, o.pending_balance) AS combined_pending,
    COALESCE(r.undelivered_checks_amount, o.undelivered_checks_amount) AS combined_undelivered_checks
   FROM ((own o$s$);
  if v_new = v_def then raise exception 'campaign_summary: select list not found'; end if;
  select coalesce('with (' || array_to_string(reloptions, ', ') || ')', '') into v_opts from pg_class where oid = 'public.campaign_summary'::regclass;
  execute format('create or replace view public.campaign_summary %s as %s', v_opts, v_new);
end $$;
