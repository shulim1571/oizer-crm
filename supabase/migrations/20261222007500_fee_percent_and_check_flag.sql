-- Readiness #59 (2026-11-15), calculation odds and ends.
-- * A campaign's fee % was fees divided by raised including transfers in, which understated it for campaigns that
--   received transfers. It's now fees divided by gifts raised (transfers in left out).
-- * Payment methods get an "is a check" setting (is_check), filled in from today's names so nothing changes, and
--   used by the forms to show the check fields. The money rules in the balance views still recognize a check by its
--   name: they run over every gift, and looking each one's method up there would slow every balance.
-- (A failed charge later completed already gets its fee: readiness #1.)
do $$
declare v_def text; v_new text; v_opts text;
begin
  v_def := pg_get_viewdef('public.campaign_summary'::regclass);
  v_new := replace(v_def,
    $s$                    WHEN ((COALESCE(d.donations_raised, (0)::numeric) + COALESCE(t.amount_in, (0)::numeric)) = (0)::numeric) THEN (0)::numeric
                    ELSE (COALESCE(d.fees, (0)::numeric) / (COALESCE(d.donations_raised, (0)::numeric) + COALESCE(t.amount_in, (0)::numeric)))
                END AS fee_percent,$s$,
    $s$                    WHEN (COALESCE(d.donations_raised, (0)::numeric) = (0)::numeric) THEN (0)::numeric
                    ELSE (COALESCE(d.fees, (0)::numeric) / COALESCE(d.donations_raised, (0)::numeric))
                END AS fee_percent,$s$);
  if v_new = v_def then raise exception 'campaign_summary: fee percent not found'; end if;
  select coalesce('with (' || array_to_string(reloptions, ', ') || ')', '') into v_opts from pg_class where oid = 'public.campaign_summary'::regclass;
  execute format('create or replace view public.campaign_summary %s as %s', v_opts, v_new);
end $$;

alter table public.payment_methods add column if not exists is_check boolean not null default false;
update public.payment_methods set is_check = true where name ilike '%check%' and not is_check;
