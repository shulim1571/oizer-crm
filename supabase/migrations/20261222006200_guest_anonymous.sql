-- Readiness #24 (2026-11-15): a campaign's guests saw the names of donors who gave anonymously. They now see
-- "Anonymous" for those gifts. Checked the other outputs that show donor names outside the office: the payment page's
-- donor wall already leaves anonymous gifts out, gift notifications (text and email) already say "Anonymous", and the
-- machine digest and the Share box show no donor names.
do $$
declare v_def text; v_new text;
begin
  select pg_get_functiondef(p.oid) into v_def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'guest_donations';
  v_new := replace(v_def, $s$select d.created_at, coalesce(dn.display_name, nullif(d.name, ''), 'Anonymous'), d.amount, d.payment_method$s$,
                          $s$select d.created_at, case when d.anonymous then 'Anonymous' else coalesce(dn.display_name, nullif(d.name, ''), 'Anonymous') end, d.amount, d.payment_method$s$);
  if v_new = v_def then raise exception 'guest_donations: name not found'; end if;
  execute v_new;
end $$;
