-- Advisor follow-ups from the money rules. donation_defaults only ever runs as a trigger, which
-- doesn't need execute rights, so nobody should be able to reach it through the API.
revoke execute on function public.donation_defaults() from public, anon, authenticated;

create index batch_entries_org_campaign_idx on public.batch_entries (org_id, campaign_id);
create index campaign_fee_overrides_org_method_idx on public.campaign_fee_overrides (org_id, method_id);
