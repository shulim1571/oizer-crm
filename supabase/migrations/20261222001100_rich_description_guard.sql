-- The campaign description can be formatted text (Moshe Henig, 2026-11-11). The app cleans it before saving and
-- again before showing it; this keeps anything dangerous out of the database even if a request skips the app.
alter table public.campaign_page_settings drop constraint if exists campaign_page_description_safe;
alter table public.campaign_page_settings add constraint campaign_page_description_safe check (
  description is null or (
    length(description) <= 20000
    and description !~* '<\s*/?\s*(script|style|iframe|object|embed|svg|math|template|meta|link|base|form|input|textarea|button)\y'
    and description !~* '\son[a-z]+\s*='
    and description !~* '(javascript|vbscript|data)\s*:'
  )
);
