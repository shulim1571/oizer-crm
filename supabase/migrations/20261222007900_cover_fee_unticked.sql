-- Moshe #44 (approved 2026-11-15): "Cover the processing fee" starts unticked on payment pages. New templates and
-- pages already default to unticked; this turns it off on the templates and campaign pages that had it on. The
-- donor can still tick it, and an admin can turn the default back on per template or page.
update public.campaign_templates set cover_fee_default = false where cover_fee_default;
update public.campaign_page_settings set cover_fee_default = false where cover_fee_default;
