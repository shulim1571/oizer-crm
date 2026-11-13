-- Receipts (Moshe Henig and Shulim, 2026-11-12).
-- 1. A fundraiser can be given "Generate single donation receipts" (per fundraiser, off for everyone until an admin
--    grants it on the fundraiser's page, like the other permission overrides). With it they issue the standard
--    receipt for a donation on their own campaign and can print it; they can't change what it says or correct one.
--    Without it nothing changes. Nobody is given it here.
-- 2. An organization can keep its own receipt letterhead image (asset kind receipt_letterhead) for its receipt layout
--    (the receipt_layout setting). Fundraisers allowed to make receipts can read the letterhead and the director's
--    signature through receipt_assets(), and nothing else from the asset store.
alter table public.fundraiser_overrides drop constraint if exists fundraiser_overrides_permission_check;
alter table public.fundraiser_overrides add constraint fundraiser_overrides_permission_check check (permission = any (array[
  'enter_manual_payments', 'view_donors_beyond', 'request_payouts', 'payout_visibility', 'view_fee_breakdown', 'source_reports',
  'bulk_receipts', 'custom_fields', 'single_receipts']));

alter table public.check_assets drop constraint if exists check_assets_kind_check;
alter table public.check_assets add constraint check_assets_kind_check check (kind = any (array['signature', 'micr_font', 'director_signature', 'receipt_letterhead']));

CREATE OR REPLACE FUNCTION public.issue_receipt(p_donation text, p_amount numeric DEFAULT NULL::numeric, p_date date DEFAULT NULL::date, p_amount_reason text DEFAULT NULL::text, p_hebrew_salutation text DEFAULT NULL::text, p_hebrew_text text DEFAULT NULL::text, p_english_text text DEFAULT NULL::text, p_corrects text DEFAULT NULL::text, p_donor_name text DEFAULT NULL::text, p_donor_address text DEFAULT NULL::text, p_campaign_name text DEFAULT NULL::text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org uuid := public.current_org_id();
  d public.donations;
  dn public.donors;
  t record;
  v_ids text[];
  v_items jsonb;
  v_total numeric;
  v_id text;
begin
  -- Admins, or a fundraiser an admin gave "Generate single donation receipts", for a donation on their own campaign,
  -- issuing the standard receipt only (Moshe Henig, 2026-11-12).
  if not public.is_admin() then
    select * into d from public.donations x where x.org_id = v_org and x.id = p_donation;
    if d.id is null then raise exception 'Donation not found'; end if;
    if public.my_org_role() is distinct from 'manager' or not (d.campaign_id = any(coalesce(public.my_campaign_ids(), '{}')))
       or not public.has_override('single_receipts', d.campaign_id) then
      raise exception 'Only an admin, or a fundraiser given permission to generate receipts, can issue a receipt';
    end if;
    if coalesce(p_amount, p_date::text, p_amount_reason, p_hebrew_salutation, p_hebrew_text, p_english_text, p_corrects, p_donor_name, p_donor_address, p_campaign_name) is not null then
      raise exception 'Only an admin can change what a receipt says or correct one';
    end if;
  end if;
  select * into d from public.donations x where x.org_id = v_org and x.id = p_donation for update;
  if d.id is null then raise exception 'Donation not found'; end if;
  if public.receipt_blocker(d) is not null then raise exception '%', public.receipt_blocker(d); end if;
  if d.split_group_id is not null then
    select array_agg(x.id order by x.created_at, x.id), sum(x.amount),
           jsonb_agg(jsonb_build_object('campaign_id', x.campaign_id, 'campaign', coalesce(c.external_name, c.internal_name, c.campaign_name), 'amount', x.amount) order by x.created_at, x.id)
      into v_ids, v_total, v_items
    from public.donations x left join public.campaigns c on c.org_id = x.org_id and c.id = x.campaign_id
    where x.org_id = v_org and x.split_group_id = d.split_group_id and x.status = 'completed' and x.deleted_at is null;
    select x.* into d from public.donations x where x.org_id = v_org and x.id = v_ids[1];
  else
    v_ids := array[d.id];
    v_total := d.amount;
    v_items := '[]';
  end if;
  if exists (select 1 from public.receipts r where r.org_id = v_org and r.donation_ids && v_ids and r.status = 'issued') then
    raise exception 'This donation already has receipt %. Use Void & Correct to change it',
      (select r.receipt_number from public.receipts r where r.org_id = v_org and r.donation_ids && v_ids and r.status = 'issued' limit 1);
  end if;
  if p_amount is not null and p_amount <= 0 then raise exception 'The receipt amount has to be more than zero'; end if;
  select * into dn from public.donors x where x.org_id = v_org and x.id = d.donor_id;
  select * into t from public.receipt_text(d.campaign_id);
  insert into public.receipts (org_id, receipt_number, donation_id, donation_ids, donor_id, donor_name, donor_title, donor_address, hebrew_name,
                               campaign_id, campaign_name, items, actual_amount, amount, amount_reason, receipt_date,
                               hebrew_salutation, hebrew_text, english_text, corrects_id)
  values (v_org, public.next_reference(v_org, 'R'), d.id, v_ids, d.donor_id,
          coalesce(nullif(trim(p_donor_name), ''), nullif(trim(concat_ws(' ', dn.first_name, dn.last_name)), ''), dn.display_name, d.name),
          dn.english_title,
          coalesce(nullif(trim(p_donor_address), ''), dn.address),
          nullif(trim(concat_ws(' ', dn.yiddish_title, dn.yiddish_first_name, dn.yiddish_last_name, dn.yiddish_suffix)), ''),
          d.campaign_id,
          coalesce(nullif(trim(p_campaign_name), ''), (select coalesce(c.external_name, c.internal_name, c.campaign_name) from public.campaigns c where c.org_id = v_org and c.id = d.campaign_id)),
          v_items, v_total, round(coalesce(p_amount, v_total), 2), nullif(trim(p_amount_reason), ''),
          coalesce(p_date, (d.created_at at time zone coalesce((select s.value #>> '{}' from public.settings s where s.org_id = v_org and s.key = 'timezone'), 'America/New_York'))::date),
          coalesce(nullif(trim(p_hebrew_salutation), ''), t.hebrew_salutation), coalesce(nullif(trim(p_hebrew_text), ''), t.hebrew_text),
          coalesce(nullif(trim(p_english_text), ''), t.english_text), p_corrects)
  returning id into v_id;
  return v_id;
end $function$;

-- The letterhead is an image, like the signatures.
create or replace function public.save_check_asset(p_kind text, p_account text, p_base64 text, p_mime text, p_file_name text default null,
  p_transit_char text default null, p_onus_char text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_bytes bytea;
begin
  perform public.require_admin();
  if p_kind in ('signature','director_signature') and p_mime not in ('image/png','image/jpeg') then raise exception 'The signature has to be a PNG or JPG image'; end if;
  if p_kind = 'receipt_letterhead' and p_mime not in ('image/png','image/jpeg') then raise exception 'The receipt letterhead has to be a PNG or JPG image'; end if;
  if p_kind = 'micr_font' and p_mime not in ('font/ttf','font/otf','application/octet-stream','application/x-font-ttf','font/sfnt') then
    raise exception 'The MICR font has to be a TTF or OTF file';
  end if;
  v_bytes := decode(p_base64, 'base64');
  if length(v_bytes) > 1048576 then raise exception 'That file is over 1 MB'; end if;
  insert into public.check_assets (org_id, kind, account_id, file_name, mime, content, transit_char, onus_char)
  values (public.current_org_id(), p_kind, case when p_kind = 'signature' then coalesce(p_account, '') else '' end,
          p_file_name, p_mime, v_bytes, left(nullif(p_transit_char, ''), 1), left(nullif(p_onus_char, ''), 1))
  on conflict (org_id, kind, account_id) do update
  set file_name = excluded.file_name, mime = excluded.mime, content = excluded.content,
      transit_char = excluded.transit_char, onus_char = excluded.onus_char, updated_by = public.current_email(), updated_at = now();
end $$;

-- What a receipt page needs from the asset store: the letterhead and the director's signature, for admins and for
-- fundraisers allowed to make receipts.
create or replace function public.receipt_assets()
returns table (kind text, mime text, data_hex text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (public.is_admin() or exists (
    select 1 from public.fundraiser_overrides o
    where o.org_id = public.current_org_id() and o.manager_id = any(public.my_manager_ids()) and o.revoked_at is null
      and o.permission in ('single_receipts', 'bulk_receipts'))) then
    return;
  end if;
  return query select a.kind, a.mime, encode(a.content, 'hex') from public.check_assets a
    where a.org_id = public.current_org_id() and a.kind in ('director_signature', 'receipt_letterhead') and a.account_id = '';
end $$;
revoke execute on function public.receipt_assets() from public, anon;
grant execute on function public.receipt_assets() to authenticated;
