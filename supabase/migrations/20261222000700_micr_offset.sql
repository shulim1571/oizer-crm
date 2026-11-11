-- The MICR line moves on its own (Moshe Henig, 2026-11-11: "Just the micr numbers should be able to move them
-- separately then the whole check"): its own right/up adjustment in millimetres, on top of the whole-check nudge,
-- leaving the rest of the check where it is. Saved with the account's other check print settings.

alter table public.account_check_settings
  add column if not exists micr_offset_x numeric(5,2) not null default 0 check (micr_offset_x between -25 and 25),
  add column if not exists micr_offset_y numeric(5,2) not null default 0 check (micr_offset_y between -25 and 25);

drop function if exists public.save_check_settings(text, text, text, text, text, text, integer, numeric, numeric);
create or replace function public.save_check_settings(p_account text, p_print_name text, p_print_address text, p_bank_name text,
  p_routing text, p_account_number text, p_next_number integer, p_offset_x numeric default 0, p_offset_y numeric default 0,
  p_micr_offset_x numeric default null, p_micr_offset_y numeric default null)
returns void
language plpgsql security definer set search_path = '' as $function$
declare v_org uuid := public.current_org_id();
begin
  perform public.require_admin();
  if not exists (select 1 from public.accounts a where a.org_id = v_org and a.id = p_account and a.deleted_at is null) then
    raise exception 'Account not found';
  end if;
  if nullif(regexp_replace(coalesce(p_routing, ''), '\D', '', 'g'), '') is not null
     and length(regexp_replace(p_routing, '\D', '', 'g')) <> 9 then
    raise exception 'A routing number has 9 digits';
  end if;
  if p_next_number is not null and exists (
    select 1 from public.checks k where k.org_id = v_org and k.account_id = p_account and k.check_number >= p_next_number) then
    raise exception 'Check numbers up to % have already been used on this account', (select max(k.check_number) from public.checks k where k.org_id = v_org and k.account_id = p_account);
  end if;
  insert into public.account_check_settings (org_id, account_id, print_name, print_address, bank_name, routing_number, account_number,
                                             next_check_number, offset_x, offset_y, micr_offset_x, micr_offset_y)
  values (v_org, p_account, nullif(trim(p_print_name), ''), nullif(trim(p_print_address), ''), nullif(trim(p_bank_name), ''),
          nullif(regexp_replace(coalesce(p_routing, ''), '\D', '', 'g'), ''), nullif(regexp_replace(coalesce(p_account_number, ''), '\D', '', 'g'), ''),
          p_next_number, coalesce(p_offset_x, 0), coalesce(p_offset_y, 0), coalesce(p_micr_offset_x, 0), coalesce(p_micr_offset_y, 0))
  on conflict (org_id, account_id) do update
  set print_name = excluded.print_name, print_address = excluded.print_address, bank_name = excluded.bank_name,
      routing_number = excluded.routing_number, account_number = excluded.account_number, next_check_number = excluded.next_check_number,
      offset_x = excluded.offset_x, offset_y = excluded.offset_y,
      -- Left out (an older page), the MICR line keeps where it was.
      micr_offset_x = coalesce(p_micr_offset_x, public.account_check_settings.micr_offset_x),
      micr_offset_y = coalesce(p_micr_offset_y, public.account_check_settings.micr_offset_y), updated_by = public.current_email(), updated_at = now();
end $function$;

revoke execute on function public.save_check_settings(text, text, text, text, text, text, integer, numeric, numeric, numeric, numeric) from public, anon;
grant execute on function public.save_check_settings(text, text, text, text, text, text, integer, numeric, numeric, numeric, numeric) to authenticated;
