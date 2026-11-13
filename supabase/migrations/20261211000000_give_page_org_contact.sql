-- The organization's email and phone on the public payment page banner (Moshe Henig, 2026-11-10), from its
-- settings (Organization > Identity). Each is left out when it isn't set. Same function as before, plus the two.

create or replace function public.public_give_page(p_org uuid, p_campaign text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v jsonb := public.give_page_core(p_org, p_campaign); s public.payment_settings; v_site text; o public.organizations;
begin
  if v is null then return null; end if;
  select * into s from public.payment_settings where org_id = p_org;
  select k.turnstile_site_key into v_site from public.integration_keys k where k.org_id = p_org and k.turnstile_secret is not null;
  select * into o from public.organizations where id = p_org;
  v := jsonb_set(v, '{org}', coalesce(v -> 'org', '{}') || jsonb_build_object(
    'email', nullif(trim(o.email), ''),
    'phone', nullif(trim(o.phone), '')));
  return jsonb_set(v, '{payments}', (v -> 'payments') || jsonb_build_object(
    'ach', coalesce(s.ach_enabled, false),
    'daf', to_jsonb(coalesce(s.daf_programs, '{}')),
    'ach_authorization', case when s.ach_enabled then public.ach_authorization_text(p_org) end,
    'turnstile_site_key', v_site));
end $$;
