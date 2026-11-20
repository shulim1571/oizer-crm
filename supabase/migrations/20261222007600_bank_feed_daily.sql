-- Readiness #60 (2026-11-15): the bank feed and bank fees.
-- * Every linked bank account (Plaid) syncs on its own once a day: kick_plaid_sync() calls the plaid function's
--   scheduled path with the same cron token the Donary sync uses.
-- * Bank lines left unmatched more than 7 days are a line in the nightly books check, so they reach the Task Sheet.
-- * (A bank line is recorded as a bank fee or interest in one click on the reconciliation page.)

-- The linked accounts, for the scheduled sync only.
create or replace function public.plaid_linked_accounts() returns table (org_id uuid, account_id text)
language sql stable security definer set search_path = '' as $$
  select p.org_id, p.account_id from public.plaid_items p join public.organizations o on o.id = p.org_id and o.status = 'active'
$$;
revoke execute on function public.plaid_linked_accounts() from public, anon, authenticated;
grant execute on function public.plaid_linked_accounts() to service_role;

create or replace function public.kick_plaid_sync() returns void
language plpgsql security definer set search_path = '' as $$
declare v_url text; v_token text;
begin
  if not exists (select 1 from public.plaid_items) then return; end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into v_token from vault.decrypted_secrets where name = 'messaging_cron_token';
  if v_url is null or v_token is null then return; end if;
  perform net.http_post(url := rtrim(v_url, '/') || '/functions/v1/plaid',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-token', v_token), body := '{"action":"sync_all"}'::jsonb);
end $$;
revoke execute on function public.kick_plaid_sync() from public, anon, authenticated;

-- Once a day, 6:40 AM New York time in winter (11:40 UTC), before the office starts.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    perform cron.schedule('plaid_sync', '40 11 * * *', $c$select public.kick_plaid_sync()$c$);
  end if;
end $$;

-- The books check: bank lines unmatched more than 7 days (outside signed-off periods).
do $$
declare v_def text; v_new text;
begin
  select pg_get_functiondef(p.oid) into v_def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'integrity_checks';
  v_new := replace(v_def, $s$  union all
  select 'refunds_as_voids',$s$, $s$  union all
  select 'stale_bank_lines', 'Bank lines not matched for more than 7 days', count(*), sum(l.amount)
    from public.bank_lines l
   where l.org_id = p_org and l.match_id is null and l.posted_date < public.org_today() - 7
     and l.posted_date > coalesce(public.bank_locked_through(p_org, l.account_id), '-infinity'::date)
  union all
  select 'refunds_as_voids',$s$);
  if v_new = v_def then raise exception 'integrity_checks: insertion point not found'; end if;
  execute v_new;
end $$;
