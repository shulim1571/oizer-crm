-- Plaid, sandbox only (Shulim, 2026-11-11): link a bank account through Plaid Link with a sandbox test
-- institution, keep its access token encrypted, and sync its transactions into bank_lines (source 'plaid'),
-- where reconciliation already matches them. Sample data only; no real banks, no production keys.
--
-- The Plaid keys are never in the code or this database: the plaid Edge Function reads PLAID_CLIENT_ID,
-- PLAID_SANDBOX_SECRET and PLAID_ENV (default sandbox) from its secrets, and refuses anything but the sandbox.
-- The admin's request is checked here as them first (plaid_admin_check); then the function, with the service
-- role, saves the link, reads the token back to sync, and records what came in.

create table public.plaid_items (
  org_id           uuid not null references public.organizations(id),
  account_id       text not null,
  item_id          text not null,
  access_token     bytea not null,              -- encrypted with payment_keys_key()
  environment      text not null default 'sandbox' check (environment = 'sandbox'),
  institution_name text,
  plaid_account_id text not null,
  account_name     text,
  account_mask     text,
  cursor           text,
  last_synced_at   timestamptz,
  last_error       text,
  linked_by        text,
  linked_at        timestamptz not null default now(),
  primary key (org_id, account_id),
  foreign key (org_id, account_id) references public.accounts (org_id, id) on update cascade
);
alter table public.plaid_items enable row level security;
revoke all on public.plaid_items from public, anon, authenticated;

-- As the admin: may this person link or sync this bank account? Returns the organization.
create or replace function public.plaid_admin_check(p_account text) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  perform public.require_admin();
  perform public.recon_require_account(v_org, p_account);
  return v_org;
end $$;

-- What the Reconciliation page shows about each account's link (never the token).
create or replace function public.plaid_status()
returns table (account_id text, institution_name text, account_name text, account_mask text, environment text,
               linked_by text, linked_at timestamptz, last_synced_at timestamptz, last_error text)
language sql stable security definer set search_path = '' as $$
  select p.account_id, p.institution_name, p.account_name, p.account_mask, p.environment, p.linked_by, p.linked_at, p.last_synced_at, p.last_error
  from public.plaid_items p
  where p.org_id = public.current_org_id() and public.is_admin()
$$;

-- Service role only, from the plaid function.
create or replace function public.plaid_save_item(p_org uuid, p_account text, p_item_id text, p_access_token text, p_institution text,
                                                  p_plaid_account text, p_name text, p_mask text, p_by text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.plaid_items (org_id, account_id, item_id, access_token, institution_name, plaid_account_id, account_name, account_mask, linked_by)
  values (p_org, p_account, p_item_id, extensions.pgp_sym_encrypt(p_access_token, public.payment_keys_key()), left(p_institution, 200),
          p_plaid_account, left(p_name, 200), left(p_mask, 8), p_by)
  on conflict (org_id, account_id) do update set item_id = excluded.item_id, access_token = excluded.access_token,
    institution_name = excluded.institution_name, plaid_account_id = excluded.plaid_account_id, account_name = excluded.account_name,
    account_mask = excluded.account_mask, cursor = null, last_synced_at = null, last_error = null, linked_by = excluded.linked_by, linked_at = now();
  perform public.write_activity(p_org, 'plaid_linked', 'accounts', p_account, null, jsonb_build_object('institution', p_institution, 'mask', p_mask));
end $$;

create or replace function public.plaid_item_secret(p_org uuid, p_account text)
returns table (item_id text, access_token text, plaid_account_id text, cursor text)
language sql stable security definer set search_path = '' as $$
  select p.item_id, extensions.pgp_sym_decrypt(p.access_token, public.payment_keys_key()), p.plaid_account_id, p.cursor
  from public.plaid_items p where p.org_id = p_org and p.account_id = p_account
$$;

create or replace function public.plaid_record_error(p_org uuid, p_account text, p_error text) returns void
language sql security definer set search_path = '' as $$
  update public.plaid_items set last_error = left(p_error, 500) where org_id = p_org and account_id = p_account
$$;

create or replace function public.plaid_forget(p_org uuid, p_account text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.plaid_items where org_id = p_org and account_id = p_account;
  perform public.write_activity(p_org, 'plaid_unlinked', 'accounts', p_account, null, '{}'::jsonb);
end $$;

-- One page of /transactions/sync, already narrowed to the linked account and turned into bank lines by the
-- function: [{id, date, amount (money in is positive), description, check_number}]. Added lines are new bank
-- lines (a line seen before is skipped); modified ones are updated while unmatched; removed ones are deleted
-- while unmatched. Nothing is touched in a signed-off period. The cursor moves on only with the lines.
create or replace function public.plaid_apply_sync(p_org uuid, p_account text, p_added jsonb, p_modified jsonb, p_removed jsonb, p_cursor text)
returns table (added integer, updated integer, removed integer)
language plpgsql security definer set search_path = '' as $$
declare v_lock date := public.bank_locked_through(p_org, p_account); v_added int; v_updated int; v_removed int;
begin
  if not exists (select 1 from public.plaid_items p where p.org_id = p_org and p.account_id = p_account) then
    raise exception 'This bank account isn''t linked to Plaid';
  end if;

  insert into public.bank_lines (org_id, account_id, posted_date, amount, description, check_number, bank_ref, source, fingerprint, created_by)
  select p_org, p_account, (x ->> 'date')::date, round((x ->> 'amount')::numeric, 2), left(nullif(trim(x ->> 'description'), ''), 500),
         nullif(ltrim(regexp_replace(coalesce(x ->> 'check_number', ''), '\D', '', 'g'), '0'), ''), x ->> 'id', 'plaid', 'plaid:' || (x ->> 'id'), 'Plaid'
  from jsonb_array_elements(coalesce(p_added, '[]')) x
  where round((x ->> 'amount')::numeric, 2) <> 0 and (v_lock is null or (x ->> 'date')::date > v_lock)
  on conflict (org_id, account_id, fingerprint) do nothing;
  get diagnostics v_added = row_count;

  update public.bank_lines l set posted_date = (x ->> 'date')::date, amount = round((x ->> 'amount')::numeric, 2),
         description = left(nullif(trim(x ->> 'description'), ''), 500)
  from jsonb_array_elements(coalesce(p_modified, '[]')) x
  where l.org_id = p_org and l.account_id = p_account and l.fingerprint = 'plaid:' || (x ->> 'id') and l.match_id is null
    and round((x ->> 'amount')::numeric, 2) <> 0 and (v_lock is null or (l.posted_date > v_lock and (x ->> 'date')::date > v_lock));
  get diagnostics v_updated = row_count;

  delete from public.bank_lines l
  using jsonb_array_elements_text(coalesce(p_removed, '[]')) r(id)
  where l.org_id = p_org and l.account_id = p_account and l.fingerprint = 'plaid:' || r.id and l.match_id is null
    and (v_lock is null or l.posted_date > v_lock);
  get diagnostics v_removed = row_count;

  update public.plaid_items set cursor = p_cursor, last_synced_at = now(), last_error = null where org_id = p_org and account_id = p_account;
  return query select v_added, v_updated, v_removed;
end $$;

revoke execute on function public.plaid_admin_check(text) from public, anon;
revoke execute on function public.plaid_status() from public, anon;
grant execute on function public.plaid_admin_check(text) to authenticated;
grant execute on function public.plaid_status() to authenticated;
do $$
declare f text;
begin
  foreach f in array array['plaid_save_item(uuid, text, text, text, text, text, text, text, text)', 'plaid_item_secret(uuid, text)',
                           'plaid_record_error(uuid, text, text)', 'plaid_forget(uuid, text)', 'plaid_apply_sync(uuid, text, jsonb, jsonb, jsonb, text)'] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
