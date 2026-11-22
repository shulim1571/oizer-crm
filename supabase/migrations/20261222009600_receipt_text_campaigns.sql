-- Receipt wording (Shulim, 2026-11-22): the Hebrew/Yiddish and English text on a receipt is set in the organization's
-- settings (the default) and can be overridden per campaign; Moshe's design gives only the letterhead, layout and fonts.
-- Campaign text wins over a fundraiser's, which wins over the default (campaign-level text was removed earlier; Shulim
-- asked for it back). Oizer's default becomes the wording on Moshe's design; the text it replaces is kept in the setting
-- receipt_text_previous.

alter table public.receipt_templates drop constraint if exists receipt_templates_level_check;
alter table public.receipt_templates add constraint receipt_templates_level_check check (level = any (array['default', 'fundraiser', 'campaign']));

create or replace function public.save_receipt_template(p_level text, p_ref text, p_hebrew_salutation text, p_hebrew_text text, p_english_text text)
returns void language plpgsql security definer set search_path = '' as $function$
declare v_org uuid := public.current_org_id();
begin
  if p_level not in ('default', 'fundraiser', 'campaign') then raise exception 'Unknown receipt text level'; end if;
  if not public.is_admin() then raise exception 'Only admins can change receipt text'; end if;
  if p_level = 'fundraiser' and not exists (select 1 from public.managers m where m.org_id = v_org and m.id = p_ref) then raise exception 'Fundraiser not found'; end if;
  if p_level = 'campaign' and not exists (select 1 from public.campaigns c where c.org_id = v_org and c.id = p_ref and c.deleted_at is null) then raise exception 'Campaign not found'; end if;
  if coalesce(nullif(trim(p_hebrew_salutation), ''), nullif(trim(p_hebrew_text), ''), nullif(trim(p_english_text), '')) is null then
    delete from public.receipt_templates where org_id = v_org and level = p_level and ref_id = coalesce(p_ref, '');
    return;
  end if;
  insert into public.receipt_templates (org_id, level, ref_id, hebrew_salutation, hebrew_text, english_text)
  values (v_org, p_level, coalesce(p_ref, ''), nullif(trim(p_hebrew_salutation), ''), nullif(trim(p_hebrew_text), ''), nullif(trim(p_english_text), ''))
  on conflict (org_id, level, ref_id) do update
  set hebrew_salutation = excluded.hebrew_salutation, hebrew_text = excluded.hebrew_text, english_text = excluded.english_text,
      updated_by = public.current_email(), updated_at = now();
end $function$;

-- The text for a campaign's receipts: each part from the campaign if it has one, else the fundraiser's, else the default.
create or replace function public.receipt_text(p_campaign text)
returns table (hebrew_salutation text, hebrew_text text, english_text text)
language sql stable security definer set search_path = '' as $function$
  with c as (select c.org_id, c.id, c.manager_id from public.campaigns c where c.org_id = public.current_org_id() and c.id = p_campaign),
  t as (
    select 1 as rank, r.* from public.receipt_templates r join c on r.org_id = c.org_id and r.level = 'campaign' and r.ref_id = c.id
    union all
    select 2, r.* from public.receipt_templates r join c on r.org_id = c.org_id and r.level = 'fundraiser' and r.ref_id = c.manager_id
    union all
    select 3, r.* from public.receipt_templates r where r.org_id = public.current_org_id() and r.level = 'default'
  )
  select (select t.hebrew_salutation from t where t.hebrew_salutation is not null order by rank limit 1),
         (select t.hebrew_text from t where t.hebrew_text is not null order by rank limit 1),
         (select t.english_text from t where t.english_text is not null order by rank limit 1)
$function$;

-- Oizer's default: the wording on Moshe's design (with its blanks), keeping what it replaces.
insert into public.settings (org_id, key, value)
select r.org_id, 'receipt_text_previous', jsonb_build_object('hebrew_salutation', r.hebrew_salutation, 'hebrew_text', r.hebrew_text, 'english_text', r.english_text, 'saved_at', now())
from public.receipt_templates r where r.org_id = '00000000-0000-4000-8000-000000000001' and r.level = 'default'
on conflict (org_id, key) do nothing;

insert into public.receipt_templates (org_id, level, ref_id, hebrew_salutation, hebrew_text, english_text)
select o.id, 'default', '',
$t$לכבוד ידידנו
**מו"ה {hebrew_name} הי"ו**$t$,
$t$הננו בזה לאשר על קבלת נדבת לבו בסך {amount}

לטובת המגבית עבור {campaign}

ועל זאת אנו עונים בקול רם להכיר טובתו ולהוקיר נדיבתו, ואמינא לפעלא טבא יישר כחו וחילו,
זכות מצות הצדקה יגן עליו ועל זרעו להתברך באושר ועושר אך טוב וחסד ירדפנו וגם ישיגו, תענוג ונחת הרחבה ושלוה בריאות גו"נ יהיו מנת חלקו עדי נזכה לביאת גוא"צ בב"א.$t$,
$t$**Dear** {name},
This is to acknowledge receipt of your generous contribution in the sum of {amount}
In the merit of this great charitable deed, may Hashem grant you and your family
health and wealth and continued success in all your endeavors
Director
**Moshe Henig**$t$
from public.organizations o where o.id = '00000000-0000-4000-8000-000000000001'
on conflict (org_id, level, ref_id) do update
set hebrew_salutation = excluded.hebrew_salutation, hebrew_text = excluded.hebrew_text, english_text = excluded.english_text,
    updated_by = 'system (Moshe''s receipt wording, 2026-11-22)', updated_at = now();
