-- The voucher form opens with its voucher ref # (Oizer's VCH-... batch number) filled in (Moshe Henig, 2026-11-11).
-- This shows the number the next voucher will get, without taking it, so cancelling a form leaves no gap. The
-- number is still given when the voucher is saved (voucher_defaults); if another voucher was saved in between, the
-- form's confirmation shows the number actually given.
create or replace function public.next_voucher_ref() returns text
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_year int := extract(year from now()); v_n int;
begin
  if not public.is_admin() then raise exception 'Only admins log vouchers'; end if;
  select last_n into v_n from public.org_counters where org_id = v_org and prefix = 'VCH' and year = v_year;
  return 'VCH-' || v_year || '-' || lpad((coalesce(v_n, 0) + 1)::text, 5, '0');
end $$;

revoke execute on function public.next_voucher_ref() from public, anon;
grant execute on function public.next_voucher_ref() to authenticated;
