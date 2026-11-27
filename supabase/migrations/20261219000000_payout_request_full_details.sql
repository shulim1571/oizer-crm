-- Full payee and bank details when an admin opens a payout request (Moshe Henig, Shulim's condition, 2026-11-11).
-- Opening a request shows the full payee name and the banking details: bank name, account type, full routing and
-- account numbers, or the Zelle address.
--   * Only the organization's admins (Admin, Super Admin, and a platform owner in that organization's session) get
--     the full numbers; this function is the only way to read them and it refuses everyone else. Fundraisers and
--     everyone else keep the masked view (last four digits, Zelle hint) stored on the request itself.
--   * Every reveal is written to the activity log: who, when, which request, and which fields were shown (never the
--     numbers themselves).

drop function if exists public.payout_request_details(text);
create function public.payout_request_details(p_request text)
returns table (method text, recipient_name text, payee_name text, bank_name text, account_type text, routing text, account text, zelle text)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  v_key text;
  r public.payout_requests;
  s public.payout_request_secrets;
begin
  perform public.require_admin();
  select * into r from public.payout_requests x where x.org_id = v_org and x.id = p_request;
  if r.id is null then raise exception 'Payout request not found'; end if;
  select * into s from public.payout_request_secrets x where x.org_id = v_org and x.request_id = p_request;
  v_key := public.payout_key();
  perform public.write_activity(v_org, 'view_payout_details', 'payout_requests', p_request, r.campaign_id,
    jsonb_build_object('method', r.method, 'fields', to_jsonb(array_remove(array[
      case when s.routing is not null then 'routing' end,
      case when s.account is not null then 'account' end,
      case when s.zelle is not null then 'zelle' end], null))));
  return query
  select r.method, r.recipient_name,
         (select p.name from public.payees p where p.org_id = v_org and p.id = r.payee_id),
         r.bank_name, r.account_type,
         case when s.routing is not null then extensions.pgp_sym_decrypt(s.routing, v_key) end,
         case when s.account is not null then extensions.pgp_sym_decrypt(s.account, v_key) end,
         case when s.zelle is not null then extensions.pgp_sym_decrypt(s.zelle, v_key) end;
end $$;

revoke execute on function public.payout_request_details(text) from public, anon;
grant execute on function public.payout_request_details(text) to authenticated;
