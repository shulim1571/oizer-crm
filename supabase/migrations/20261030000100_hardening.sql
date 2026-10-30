-- Helper functions are only needed by signed-in users (RLS policies run as the caller).
revoke execute on function public.is_admin()        from public, anon;
revoke execute on function public.is_active_user()  from public, anon;
revoke execute on function public.my_manager_ids()  from public, anon;
revoke execute on function public.my_campaign_ids() from public, anon;
-- Trigger-only function: nobody should call it over the API.
revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- Cover remaining foreign keys.
create index if not exists donations_account_id_idx   on public.donations (account_id);
create index if not exists donations_collector_id_idx on public.donations (collector_id);
create index if not exists donations_source_idx       on public.donations (source);
create index if not exists expenses_account_id_idx    on public.expenses (account_id);
create index if not exists pledges_donor_id_idx       on public.pledges (donor_id);
create index if not exists tasks_donor_id_idx         on public.tasks (donor_id);
