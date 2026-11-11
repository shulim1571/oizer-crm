-- Campaigns no longer have their own receipt text (Moshe Henig, 2026-11-11). Receipts use the fundraiser's text if
-- one is set, otherwise the organization's standard receipt text. Checked first: no campaign-level receipt text
-- existed (on the sample organization only the standard text is saved), so no receipt changes wording.

delete from public.receipt_templates where level = 'campaign';
alter table public.receipt_templates drop constraint if exists receipt_templates_level_check;
alter table public.receipt_templates add constraint receipt_templates_level_check check (level in ('default', 'fundraiser'));

-- The text a receipt on this campaign gets: its primary fundraiser's, then the standard text.
create or replace function public.receipt_text(p_campaign text)
returns table (hebrew_salutation text, hebrew_text text, english_text text)
language sql stable security definer set search_path = '' as $$
  with c as (select c.org_id, c.id, c.manager_id from public.campaigns c where c.org_id = public.current_org_id() and c.id = p_campaign),
  t as (
    select 2 as rank, r.* from public.receipt_templates r join c on r.org_id = c.org_id and r.level = 'fundraiser' and r.ref_id = c.manager_id
    union all
    select 3, r.* from public.receipt_templates r where r.org_id = public.current_org_id() and r.level = 'default'
  )
  select (select t.hebrew_salutation from t where t.hebrew_salutation is not null order by rank limit 1),
         (select t.hebrew_text from t where t.hebrew_text is not null order by rank limit 1),
         (select t.english_text from t where t.english_text is not null order by rank limit 1)
$$;

create or replace function public.save_receipt_template(p_level text, p_ref text, p_hebrew_salutation text, p_hebrew_text text, p_english_text text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  if p_level = 'campaign' then raise exception 'Campaigns no longer have their own receipt text; they use the standard receipt text'; end if;
  if p_level not in ('default', 'fundraiser') then raise exception 'Unknown receipt text level'; end if;
  if not public.is_admin() then raise exception 'Only admins can change receipt text'; end if;
  if p_level = 'fundraiser' and not exists (select 1 from public.managers m where m.org_id = v_org and m.id = p_ref) then raise exception 'Fundraiser not found'; end if;
  if coalesce(nullif(trim(p_hebrew_salutation), ''), nullif(trim(p_hebrew_text), ''), nullif(trim(p_english_text), '')) is null then
    delete from public.receipt_templates where org_id = v_org and level = p_level and ref_id = coalesce(p_ref, '');
    return;
  end if;
  insert into public.receipt_templates (org_id, level, ref_id, hebrew_salutation, hebrew_text, english_text)
  values (v_org, p_level, coalesce(p_ref, ''), nullif(trim(p_hebrew_salutation), ''), nullif(trim(p_hebrew_text), ''), nullif(trim(p_english_text), ''))
  on conflict (org_id, level, ref_id) do update
  set hebrew_salutation = excluded.hebrew_salutation, hebrew_text = excluded.hebrew_text, english_text = excluded.english_text,
      updated_by = public.current_email(), updated_at = now();
end $$;

-- Fundraisers could read their campaigns' own text; only the standard text is left for them to see.
drop policy if exists primary_read on public.receipt_templates;
create policy primary_read on public.receipt_templates for select to authenticated using (level = 'default');
