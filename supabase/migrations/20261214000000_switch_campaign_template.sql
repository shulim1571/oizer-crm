-- Change an existing campaign to a different template (Moshe Henig, 2026-11-10).
--
-- How templates behave (unchanged): a template is picked when a campaign is made, and save_campaign_settings
-- copies its payment-page settings into the campaign's own campaign_page_settings row (language, preset amounts,
-- other amount, cover-fee default, minimum, receipts, donor wall, logo, color, custom fields), fills the
-- campaign's bank account only if it has none, and adds the template's fee overrides where the campaign has none.
-- From then on the campaign keeps its own copy; editing the template later doesn't reach it.
--
-- Switching does the same copy from the new template onto an existing campaign, and nothing else:
--   * replaced: the template-derived page settings listed above, and which template the campaign is on;
--   * kept: the campaign itself (names, fundraisers, goal, status, bank account, phone PIN), its donations,
--     payouts, pledges and transfers, the page's own text (description, thank-you note, banner, suggested
--     amount, page and cover-fee switches), and its existing fee overrides (the new template's are only added
--     for methods the campaign has none for); the bank account is only filled if it's empty, as at creation.
-- Admins only. Logged with both templates.

create or replace function public.switch_campaign_template(p_campaign text, p_template text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  t public.campaign_templates;
  v_old text;
begin
  perform public.require_admin();
  if not exists (select 1 from public.campaigns c where c.org_id = v_org and c.id = p_campaign and c.deleted_at is null) then
    raise exception 'Campaign not found';
  end if;
  select * into t from public.campaign_templates x where x.org_id = v_org and x.id = p_template and x.deleted_at is null;
  if t.id is null then raise exception 'Template not found'; end if;
  select s.template_id into v_old from public.campaign_page_settings s where s.org_id = v_org and s.campaign_id = p_campaign;

  insert into public.campaign_page_settings (org_id, campaign_id, template_id, language, preset_amounts, allow_other_amount, cover_fee_default,
                                             min_donation, auto_receipt, receipt_email, receipt_sms, donor_wall, logo_url, brand_color, custom_fields)
  values (v_org, p_campaign, t.id, t.language, t.preset_amounts, t.allow_other_amount, t.cover_fee_default,
          t.min_donation, t.auto_receipt, t.receipt_email, t.receipt_sms, t.donor_wall, nullif(t.logo_url, ''), nullif(t.brand_color, ''), t.custom_fields)
  on conflict (org_id, campaign_id) do update set
    template_id = excluded.template_id, language = excluded.language, preset_amounts = excluded.preset_amounts,
    allow_other_amount = excluded.allow_other_amount, cover_fee_default = excluded.cover_fee_default, min_donation = excluded.min_donation,
    auto_receipt = excluded.auto_receipt, receipt_email = excluded.receipt_email, receipt_sms = excluded.receipt_sms,
    donor_wall = excluded.donor_wall, logo_url = excluded.logo_url, brand_color = excluded.brand_color, custom_fields = excluded.custom_fields,
    updated_by = public.current_email(), updated_at = now();

  update public.campaigns c set account_id = t.account_id
  where c.org_id = v_org and c.id = p_campaign and c.account_id is null and t.account_id is not null;
  insert into public.campaign_fee_overrides (org_id, campaign_id, method_id, fee_type, fee_percent, fee_flat)
  select v_org, p_campaign, f ->> 'method_id', f ->> 'fee_type', coalesce((f ->> 'fee_percent')::numeric, 0), coalesce((f ->> 'fee_flat')::numeric, 0)
  from jsonb_array_elements(t.fee_overrides) f
  where exists (select 1 from public.payment_methods m where m.org_id = v_org and m.id = f ->> 'method_id')
  on conflict do nothing;

  perform public.write_activity(v_org, 'campaign_template_changed', 'campaigns', p_campaign, p_campaign,
    jsonb_build_object('from', v_old, 'to', t.id, 'to_name', t.name));
end $$;

revoke execute on function public.switch_campaign_template(text, text) from public, anon;
grant execute on function public.switch_campaign_template(text, text) to authenticated;
