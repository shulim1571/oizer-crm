-- Readiness #28 (2026-11-15): a check recorded but not delivered yet was offered for bank matching, though it can't
-- be in the bank. It's left off the books side until it's marked delivered (it's also not in the balance until then).
do $$
declare v_def text; v_new text;
begin
  select pg_get_functiondef(p.oid) into v_def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'recon_book_items';
  v_new := replace(v_def, $s$      and d.status in ('completed','collect','refunded','returned')
  ), items as ($s$, $s$      and d.status in ('completed','collect','refunded','returned')
      and not coalesce(d.status = 'completed' and d.delivered = false and d.payment_method ilike '%check%', false)
  ), items as ($s$);
  if v_new = v_def then raise exception 'recon_book_items: gift filter not found'; end if;
  execute v_new;
end $$;
