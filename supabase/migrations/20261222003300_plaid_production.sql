-- Plaid production for Oizer (Shulim, 2026-11-13: real bank connections are approved, Plaid only). A linked bank
-- account now records which Plaid environment it was linked in (sandbox or production), so a sandbox link is never
-- sent to production (or the other way round); the plaid function says to connect again instead. The keys stay in
-- the function's secrets (PLAID_SANDBOX_SECRET or PLAID_PRODUCTION_SECRET, chosen by PLAID_ENV); nothing here holds one.
-- Access tokens stay encrypted; two-step verification is still required for bank data (plaid_admin_check).
alter table public.plaid_items drop constraint if exists plaid_items_environment_check;
alter table public.plaid_items add constraint plaid_items_environment_check check (environment in ('sandbox', 'production'));

drop function if exists public.plaid_save_item(uuid, text, text, text, text, text, text, text, text);
create function public.plaid_save_item(p_org uuid, p_account text, p_item_id text, p_access_token text, p_institution text,
  p_plaid_account text, p_name text, p_mask text, p_by text, p_environment text default 'sandbox') returns void
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(p_environment, 'sandbox') not in ('sandbox', 'production') then raise exception 'Unknown Plaid environment'; end if;
  insert into public.plaid_items (org_id, account_id, item_id, access_token, environment, institution_name, plaid_account_id, account_name, account_mask, linked_by)
  values (p_org, p_account, p_item_id, extensions.pgp_sym_encrypt(p_access_token, public.payment_keys_key()), coalesce(p_environment, 'sandbox'),
          left(p_institution, 200), p_plaid_account, left(p_name, 200), left(p_mask, 8), p_by)
  on conflict (org_id, account_id) do update set item_id = excluded.item_id, access_token = excluded.access_token, environment = excluded.environment,
    institution_name = excluded.institution_name, plaid_account_id = excluded.plaid_account_id, account_name = excluded.account_name,
    account_mask = excluded.account_mask, cursor = null, last_synced_at = null, last_error = null, linked_by = excluded.linked_by, linked_at = now();
  perform public.write_activity(p_org, 'plaid_linked', 'accounts', p_account, null,
    jsonb_build_object('institution', p_institution, 'mask', p_mask, 'environment', coalesce(p_environment, 'sandbox')));
end $$;

drop function if exists public.plaid_item_secret(uuid, text);
create function public.plaid_item_secret(p_org uuid, p_account text)
returns table (item_id text, access_token text, plaid_account_id text, cursor text, environment text)
language sql stable security definer set search_path = '' as $$
  select p.item_id, extensions.pgp_sym_decrypt(p.access_token, public.payment_keys_key()), p.plaid_account_id, p.cursor, p.environment
  from public.plaid_items p where p.org_id = p_org and p.account_id = p_account
$$;

revoke execute on function public.plaid_save_item(uuid, text, text, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.plaid_save_item(uuid, text, text, text, text, text, text, text, text, text) to service_role;
revoke execute on function public.plaid_item_secret(uuid, text) from public, anon, authenticated;
grant execute on function public.plaid_item_secret(uuid, text) to service_role;
