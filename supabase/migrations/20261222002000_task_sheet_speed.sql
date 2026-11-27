-- Task Sheet speed (Moshe Henig, 2026-11-12: "the Task Sheet takes too long to load").
-- The "inactive campaign" check in admin_task_sheet finds each active campaign's latest donation. With no index on
-- (campaign, date) the database walked the whole donations-by-date index once per campaign: about 4.7 of the
-- 4.8 seconds the sheet took on the sample organization, paid again by the sidebar's task count. This index makes
-- each lookup a single step. Nothing the sheet shows changes; only how fast it is found.
create index if not exists donations_org_campaign_created_idx
  on public.donations (org_id, campaign_id, created_at desc)
  where deleted_at is null;

-- The same lookup on expenses (already fast with few rows, but it grows the same way).
create index if not exists expenses_org_campaign_created_idx
  on public.expenses (org_id, campaign_id, created_at desc)
  where deleted_at is null;
