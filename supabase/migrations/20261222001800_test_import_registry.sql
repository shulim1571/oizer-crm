-- A test import of real AppSheet data, authorized once by Shulim (2026-11-12), must be removable in one step before
-- the real migration. This adds only structure, no data:
--   * test_import_batches / test_import_rows: every row a test import creates is registered under its batch id, with
--     the AppSheet row id it came from (never personal details).
--   * delete_test_import(batch): removes exactly the registered rows (children first), then the registry entries.
--     Only the database owner / service role can run it; it switches the tables' own rules off just for the delete,
--     so a closed campaign or a soft-delete rule can't turn it into a partial delete.
--   * A check payout with a check number typed on it (hand-written, as in AppSheet's history) isn't a "Check To
--     Print" task.

create table if not exists public.test_import_batches (
  batch_id    text primary key,
  org_id      uuid not null references public.organizations(id),
  note        text,
  counts      jsonb not null default '{}',
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create table if not exists public.test_import_rows (
  batch_id     text not null references public.test_import_batches(batch_id),
  table_name   text not null check (table_name in ('accounts','sources','managers','collectors','donors','campaigns','donations','expenses','transfers','pledges','tasks')),
  record_id    text not null,
  source_sheet text,
  source_id    text,
  primary key (batch_id, table_name, record_id)
);
create index if not exists test_import_rows_record on public.test_import_rows (table_name, record_id);
alter table public.test_import_batches enable row level security;
alter table public.test_import_rows enable row level security;
revoke all on public.test_import_batches, public.test_import_rows from public, anon, authenticated;

create or replace function public.delete_test_import(p_batch text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  b public.test_import_batches;
  t text;
  n integer;
  v_out jsonb := '{}';
begin
  select * into b from public.test_import_batches where batch_id = p_batch;
  if b.batch_id is null then raise exception 'No test import batch %', p_batch; end if;
  -- Children before parents.
  foreach t in array array['donations','pledges','transfers','expenses','tasks','campaigns','donors','collectors','managers','sources','accounts'] loop
    execute format('alter table public.%I disable trigger user', t);
    execute format('delete from public.%I x using public.test_import_rows r where r.batch_id = $1 and r.table_name = %L and x.org_id = $2 and x.id = r.record_id', t, t)
      using p_batch, b.org_id;
    get diagnostics n = row_count;
    execute format('alter table public.%I enable trigger user', t);
    v_out := v_out || jsonb_build_object(t, n);
  end loop;
  -- Task Sheet items a test payout or check may have raised since.
  delete from public.task_items i using public.test_import_rows r
  where r.batch_id = p_batch and r.table_name = 'expenses' and i.org_id = b.org_id and i.task_key = 'check_to_print:' || r.record_id;
  delete from public.test_import_rows where batch_id = p_batch;
  update public.test_import_batches set deleted_at = now() where batch_id = p_batch;
  return v_out;
end $$;
revoke execute on function public.delete_test_import(text) from public, anon, authenticated;

create or replace function public.refresh_check_to_print(p_org uuid, p_expense text) returns void
language plpgsql security definer set search_path = '' as $$
declare e public.expenses; v_key text := 'check_to_print:' || p_expense;
begin
  select * into e from public.expenses x where x.org_id = p_org and x.id = p_expense;
  -- A check number typed on a payout that never had a check issued here (a hand-written check, as in AppSheet's
  -- history) means there's nothing to print. A voided or lost check still brings its payout back to print.
  if e.id is not null and e.method = 'Check' and e.deleted_at is null and e.cleared is not true and e.processed_at is not null
     and (nullif(trim(e.check_number), '') is null or exists (select 1 from public.checks k0 where k0.org_id = p_org and k0.expense_id = e.id))
     and not exists (select 1 from public.checks k where k.org_id = p_org and k.expense_id = e.id and k.status in ('outstanding','cleared')) then
    insert into public.task_items (org_id, task_key, task_type, record_id, campaign_id, amount, summary)
    values (p_org, v_key, 'check_to_print', e.id, e.campaign_id, e.amount,
            format('Check to %s: not printed yet', coalesce(nullif(trim(e.payee), ''), 'a payee still to be chosen')))
    on conflict (org_id, task_key) do update
      set resolved_at = null, campaign_id = excluded.campaign_id, amount = excluded.amount, summary = excluded.summary;
  else
    update public.task_items set resolved_at = now() where org_id = p_org and task_key = v_key and resolved_at is null;
  end if;
end $$;
