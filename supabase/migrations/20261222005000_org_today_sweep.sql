-- Readiness #12 (2026-11-15): dates in the money paths are the organization's dates (New York by default), not UTC.
--
-- * A backdated voucher funding was stamped p_date::timestamptz, midnight UTC, which is the evening before in New
--   York, so it landed on the previous day. It is now stamped at noon on that day in the organization's time zone.
-- * current_date is the database's (UTC) date: after 7 PM in New York it is already tomorrow. Every function and
--   view that used it (post-dated checks, pledge schedule windows, voucher and pledge lists, refunds, returns, the
--   Task Sheet...) now uses public.org_today(), today in the organization's time zone (New York when unknown).
--   Done mechanically over the live definitions, so nothing else in them changes.

do $$
declare
  r record;
  v_def text;
begin
  -- Voucher funding: noon on the chosen day, organization time.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'add_voucher_funding';
  if v_def is not null then
    v_def := replace(v_def, 'p_date::timestamptz', $r$((p_date + time '12:00') at time zone public.org_zone(v_org))$r$);
    execute v_def;
  end if;

  -- Functions.
  for r in
    select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f' and p.prosrc ~* '\ycurrent_date\y' and p.proname <> 'org_today'
  loop
    v_def := regexp_replace(pg_get_functiondef(r.oid), '\ycurrent_date\y', 'public.org_today()', 'gi');
    execute v_def;
  end loop;

  -- Views, keeping their options (security_invoker).
  for r in
    select c.oid, c.relname, c.reloptions from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'v' and pg_get_viewdef(c.oid) ~* '\ycurrent_date\y'
  loop
    execute format('create or replace view public.%I %s as %s', r.relname,
      case when r.reloptions is null then '' else 'with (' || array_to_string(r.reloptions, ', ') || ')' end,
      regexp_replace(pg_get_viewdef(r.oid), '\ycurrent_date\y', 'public.org_today()', 'gi'));
  end loop;
end $$;
