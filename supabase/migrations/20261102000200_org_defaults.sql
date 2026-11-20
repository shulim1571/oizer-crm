-- New-record defaults the app used to hard-code for Oizer. Every organization gets the "Manual"
-- source that manual entries point at, and its own default bank account setting.

create or replace function public.seed_org_settings(p_org uuid) returns void
language sql security definer set search_path = '' as $$
  insert into public.settings (org_id, key, value, description, updated_by) values
    (p_org, 'timezone', '"America/New_York"', 'Time zone for dates, reports and digests', 'system'),
    (p_org, 'duplicate_window_minutes', '10', 'Same donor, amount and campaign within this window is flagged as a possible duplicate', 'system'),
    (p_org, 'inactive_campaign_days', '90', 'Active campaigns with no activity for this long are flagged', 'system'),
    (p_org, 'stale_check_days', '90', 'Outstanding checks older than this are flagged', 'system'),
    (p_org, 'max_phones_per_fundraiser', '3', 'Registered phone numbers allowed per fundraiser', 'system'),
    (p_org, 'auto_receipt', 'false', 'Send receipts automatically unless a campaign overrides it', 'system'),
    (p_org, 'machine_digest_time', '"22:00"', 'When the daily Donary machine summary goes out', 'system')
  on conflict do nothing;
  insert into public.sources (org_id, id, name) values (p_org, 'Manual', 'Manual')
  on conflict do nothing;
$$;

insert into public.sources (org_id, id, name)
select id, 'Manual', 'Manual' from public.organizations
on conflict do nothing;

-- Oizer's existing default, wherever that account was imported.
insert into public.settings (org_id, key, value, description, updated_by)
select a.org_id, 'default_account_id', to_jsonb(a.id), 'Account pre-selected on new donations and expenses', 'system'
from public.accounts a
where a.id = '8d4b5fbe' and a.org_id = '00000000-0000-4000-8000-000000000001'
on conflict do nothing;
