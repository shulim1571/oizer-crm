-- Scheduled jobs: pg_cron calls run_job, which records every run. Later phases add cases
-- (post-dated checks, overdue pledges, digests) to run_job and a cron.schedule line.

create extension if not exists pg_cron;

create table public.job_runs (
  id          bigint generated always as identity primary key,
  job         text not null,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  ok          boolean,
  error       text
);
create index on public.job_runs (job, started_at desc);

alter table public.job_runs enable row level security;
revoke all on public.job_runs from anon, authenticated;
grant select on public.job_runs to authenticated;
create policy admin_read on public.job_runs for select to authenticated using ((select public.is_admin()));

-- A failing job is recorded rather than raised, so the failure survives in job_runs.
create or replace function public.run_job(p_job text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_id bigint;
begin
  insert into public.job_runs (job) values (p_job) returning id into v_id;
  begin
    case p_job
      when 'heartbeat' then null;
      else raise exception 'Unknown job %', p_job;
    end case;
    update public.job_runs set finished_at = now(), ok = true where id = v_id;
  exception when others then
    update public.job_runs set finished_at = now(), ok = false, error = sqlerrm where id = v_id;
  end;
end $$;

-- What the health Edge Function reports. A heartbeat older than two hours means jobs have stopped.
create or replace function public.health_check() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'database', true,
    'jobs', coalesce(max(started_at) > now() - interval '2 hours', false),
    'last_heartbeat', max(started_at))
  from public.job_runs where job = 'heartbeat' and ok
$$;

revoke execute on function public.run_job(text)    from public, anon, authenticated;
revoke execute on function public.health_check()   from public, anon, authenticated;
grant execute on function public.health_check()    to service_role;

select cron.schedule('heartbeat', '0 * * * *', $$select public.run_job('heartbeat')$$);
