-- Phase 6, part 3: receipts with permanent R-YYYY-NNNNN numbers, the receipt text cascade (single donation, campaign,
-- fundraiser, organization default), void and correct, partial receipt amounts, and year-end tax statements with a
-- permanent log. Sending by email and SMS arrives with Phase 7; for now receipts and statements are printed or saved
-- as PDF. No balance changes here.

-- ---------------------------------------------------------------------------
-- Receipt text, set at four levels. A blank field falls through to the next level.
-- ---------------------------------------------------------------------------
create table public.receipt_templates (
  org_id            uuid not null default public.current_org_id() references public.organizations(id),
  level             text not null check (level in ('default','fundraiser','campaign')),
  ref_id            text not null default '',
  hebrew_salutation text,
  hebrew_text       text,
  english_text      text,
  updated_by        text default public.current_email(),
  updated_at        timestamptz not null default now(),
  primary key (org_id, level, ref_id),
  check ((level = 'default') = (ref_id = ''))
);

create or replace function public.save_receipt_template(p_level text, p_ref text, p_hebrew_salutation text, p_hebrew_text text, p_english_text text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  -- The campaign's own text is the primary fundraiser's to set too.
  if not (public.is_admin() or (p_level = 'campaign' and public.is_primary_on(p_ref))) then
    raise exception 'Only admins, or the campaign''s primary fundraiser, can change receipt text';
  end if;
  if p_level = 'campaign' and not exists (select 1 from public.campaigns c where c.org_id = v_org and c.id = p_ref) then raise exception 'Campaign not found'; end if;
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

-- The text a receipt on this campaign would get now: campaign, then its primary fundraiser, then the default.
create or replace function public.receipt_text(p_campaign text)
returns table (hebrew_salutation text, hebrew_text text, english_text text)
language sql stable security definer set search_path = '' as $$
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
$$;

-- The director's signature sits with the other printing files.
alter table public.check_assets drop constraint check_assets_kind_check;
alter table public.check_assets add constraint check_assets_kind_check check (kind in ('signature','micr_font','director_signature'));

create or replace function public.save_check_asset(
  p_kind text, p_account text, p_base64 text, p_mime text, p_file_name text default null,
  p_transit_char text default null, p_onus_char text default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare v_bytes bytea;
begin
  perform public.require_admin();
  if p_kind in ('signature','director_signature') and p_mime not in ('image/png','image/jpeg') then raise exception 'The signature has to be a PNG or JPG image'; end if;
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

-- ---------------------------------------------------------------------------
-- Receipts. Everything printed is kept as it was when issued; later changes never rewrite one.
-- ---------------------------------------------------------------------------
create table public.receipts (
  id                text not null default public.short_id(),
  org_id            uuid not null default public.current_org_id() references public.organizations(id),
  receipt_number    text not null,
  donation_id       text not null,
  donation_ids      text[] not null,
  donor_id          text,
  donor_name        text,
  donor_title       text,
  donor_address     text,
  hebrew_name       text,
  campaign_id       text,
  campaign_name     text,
  items             jsonb not null default '[]',
  actual_amount     numeric(12,2) not null,
  amount            numeric(12,2) not null check (amount > 0),
  amount_reason     text,
  receipt_date      date not null,
  hebrew_salutation text,
  hebrew_text       text,
  english_text      text,
  status            text not null default 'issued' check (status in ('issued','voided')),
  void_reason       text,
  voided_by         text,
  voided_at         timestamptz,
  -- Set when the donation itself changed, so the Task Sheet asks for a corrected receipt.
  needs_reissue     boolean not null default false,
  corrects_id       text,
  issued_by         text default public.current_email(),
  issued_at         timestamptz not null default now(),
  primary key (org_id, id),
  unique (org_id, receipt_number),
  foreign key (org_id, donation_id) references public.donations (org_id, id),
  foreign key (org_id, donor_id) references public.donors (org_id, id),
  foreign key (org_id, corrects_id) references public.receipts (org_id, id)
);
create index receipts_org_donation_idx on public.receipts (org_id, donation_id);
create index receipts_donation_ids_idx on public.receipts using gin (donation_ids);
create index receipts_org_donor_idx on public.receipts (org_id, donor_id);
create index receipts_org_corrects_idx on public.receipts (org_id, corrects_id);
create unique index receipts_one_live on public.receipts (org_id, donation_id) where status = 'issued';

-- Why a donation can't have a receipt, or null when it can. DAF money gets its paperwork from the DAF.
create or replace function public.receipt_blocker(d public.donations) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when d.deleted_at is not null then 'This donation was deleted'
    when d.status <> 'completed' then 'Only a completed donation gets a receipt'
    when d.voucher_id is not null or d.type <> 'Payment' then 'Vouchers and DAF grants don''t get a receipt; the DAF sends the donor''s paperwork'
    when exists (select 1 from public.payment_methods m where m.org_id = d.org_id and lower(m.name) = lower(d.payment_method) and not m.receipt_allowed)
      then d.payment_method || ' payments don''t get a receipt; the DAF sends the donor''s paperwork'
    when d.donor_id is null and nullif(trim(d.name), '') is null then 'Add the donor first'
  end
$$;

create or replace function public.issue_receipt(
  p_donation text, p_amount numeric default null, p_date date default null, p_amount_reason text default null,
  p_hebrew_salutation text default null, p_hebrew_text text default null, p_english_text text default null,
  p_corrects text default null, p_donor_name text default null, p_donor_address text default null, p_campaign_name text default null
) returns text
language plpgsql security definer set search_path = '' as $$
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
  perform public.require_admin();
  select * into d from public.donations x where x.org_id = v_org and x.id = p_donation for update;
  if d.id is null then raise exception 'Donation not found'; end if;
  if public.receipt_blocker(d) is not null then raise exception '%', public.receipt_blocker(d); end if;
  -- A split donation gets one receipt for every part.
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
end $$;

create or replace function public.void_receipt(p_receipt text, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_admin();
  if nullif(trim(p_reason), '') is null then raise exception 'Give a reason for voiding the receipt'; end if;
  update public.receipts set status = 'voided', void_reason = trim(p_reason), voided_by = public.current_email(), voided_at = now(), needs_reissue = false
  where org_id = public.current_org_id() and id = p_receipt and status = 'issued';
  if not found then raise exception 'That receipt was already voided'; end if;
end $$;

-- Void & Correct: the old number stays, marked voided; the new receipt points back to it.
create or replace function public.correct_receipt(
  p_receipt text, p_amount numeric, p_date date, p_donor_name text default null, p_donor_address text default null,
  p_campaign_name text default null, p_reason text default null
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  r public.receipts;
  v_id text;
begin
  perform public.require_admin();
  select * into r from public.receipts where org_id = public.current_org_id() and id = p_receipt for update;
  if r.id is null then raise exception 'Receipt not found'; end if;
  if r.status = 'issued' then
    update public.receipts set status = 'voided', void_reason = coalesce(nullif(trim(p_reason), ''), 'Corrected'), voided_by = public.current_email(), voided_at = now()
    where org_id = r.org_id and id = r.id;
  end if;
  update public.receipts set needs_reissue = false where org_id = r.org_id and id = r.id;
  v_id := public.issue_receipt(r.donation_id, p_amount, p_date, case when p_amount is distinct from r.actual_amount then coalesce(nullif(trim(p_reason), ''), r.amount_reason) end,
                               r.hebrew_salutation, r.hebrew_text, r.english_text, r.id,
                               coalesce(p_donor_name, r.donor_name), coalesce(p_donor_address, r.donor_address), coalesce(p_campaign_name, r.campaign_name));
  return v_id;
end $$;

-- A donation's amount, campaign or status changed after its receipt: the receipt is voided and flagged.
create or replace function public.void_receipt_on_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.receipts r
  set status = 'voided', void_reason = 'The donation was changed', voided_by = coalesce(public.current_email(), 'system'), voided_at = now(),
      needs_reissue = new.status = 'completed' and new.deleted_at is null
  where r.org_id = new.org_id and r.donation_ids @> array[new.id] and r.status = 'issued';
  return new;
end $$;
create trigger void_receipt_on_change after update on public.donations
  for each row
  when (old.amount is distinct from new.amount or old.campaign_id is distinct from new.campaign_id
        or old.status is distinct from new.status or old.deleted_at is distinct from new.deleted_at
        or old.split_group_id is distinct from new.split_group_id)
  execute function public.void_receipt_on_change();

-- Donations in a range that could still get a receipt, for receipting in bulk.
create or replace function public.receipt_candidates(p_from date, p_to date)
returns table (donation_id text, created_at timestamptz, donor_name text, campaign_id text, amount numeric, payment_method text)
language sql stable security definer set search_path = '' as $$
  select d.id, d.created_at, coalesce(dn.display_name, d.name), d.campaign_id, d.amount, d.payment_method
  from public.donations d
  left join public.donors dn on dn.org_id = d.org_id and dn.id = d.donor_id
  where public.is_admin() and d.org_id = public.current_org_id()
    and (d.created_at at time zone 'America/New_York')::date between p_from and p_to
    and public.receipt_blocker(d) is null
    and (d.split_group_id is null or d.id = (select min(x.id) from public.donations x where x.org_id = d.org_id and x.split_group_id = d.split_group_id and x.status = 'completed' and x.deleted_at is null))
    and not exists (select 1 from public.receipts r where r.org_id = d.org_id and r.donation_ids @> array[d.id] and r.status = 'issued')
  order by d.created_at
$$;

-- ---------------------------------------------------------------------------
-- Year-end statements. The log is permanent.
-- ---------------------------------------------------------------------------
create table public.tax_statements (
  id            text not null default public.short_id(),
  org_id        uuid not null default public.current_org_id() references public.organizations(id),
  donor_id      text not null,
  tax_year      integer not null,
  scope         text not null check (scope in ('all','campaigns','fundraiser')),
  campaign_ids  text[],
  manager_id    text,
  total         numeric(12,2) not null,
  donation_count integer not null,
  revised       boolean not null default false,
  delivery      text not null default 'printed',
  generated_by  text default public.current_email(),
  generated_at  timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, donor_id) references public.donors (org_id, id),
  foreign key (org_id, manager_id) references public.managers (org_id, id)
);
create index tax_statements_org_donor_idx on public.tax_statements (org_id, donor_id, tax_year);
create index tax_statements_org_manager_idx on public.tax_statements (org_id, manager_id);

-- What goes on a statement. A receipted donation counts at its live receipt's amount, so corrections carry through.
create or replace function public.statement_items(p_donor text, p_year integer, p_campaigns text[] default null, p_manager text default null)
returns table (donation_id text, gift_date date, campaign_id text, campaign_name text, amount numeric, receipt_number text)
language sql stable security definer set search_path = '' as $$
  select d.id, (d.created_at at time zone 'America/New_York')::date, d.campaign_id,
         coalesce(c.external_name, c.internal_name, c.campaign_name),
         coalesce(case when r.items = '[]'::jsonb then r.amount end, d.amount), r.receipt_number
  from public.donations d
  join public.campaigns c on c.org_id = d.org_id and c.id = d.campaign_id
  left join public.receipts r on r.org_id = d.org_id and r.donation_ids @> array[d.id] and r.status = 'issued'
  where public.is_admin() and d.org_id = public.current_org_id() and d.donor_id = p_donor
    and extract(year from coalesce(r.receipt_date, (d.created_at at time zone 'America/New_York')::date)) = p_year
    and public.receipt_blocker(d) is null
    and (p_campaigns is null or d.campaign_id = any(p_campaigns))
    and (p_manager is null or c.manager_id = p_manager)
  order by d.created_at
$$;

create or replace function public.log_tax_statement(p_donor text, p_year integer, p_campaigns text[] default null, p_manager text default null) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  v_id text;
begin
  perform public.require_admin();
  insert into public.tax_statements (org_id, donor_id, tax_year, scope, campaign_ids, manager_id, total, donation_count, revised)
  select v_org, p_donor, p_year,
         case when p_campaigns is not null then 'campaigns' when p_manager is not null then 'fundraiser' else 'all' end,
         p_campaigns, p_manager, coalesce(sum(i.amount), 0), count(*),
         exists (select 1 from public.tax_statements s where s.org_id = v_org and s.donor_id = p_donor and s.tax_year = p_year
                 and s.campaign_ids is not distinct from p_campaigns and s.manager_id is not distinct from p_manager)
  from public.statement_items(p_donor, p_year, p_campaigns, p_manager) i
  returning id into v_id;
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- The Task Sheet gains: receipt text not set up, and receipts voided by a change that need reissuing
-- ---------------------------------------------------------------------------
create or replace view public.admin_task_sheet with (security_invoker = true) as
with items as (
  select r.org_id, 'campaign_request:' || r.id as task_key,
         case when r.resubmitted_at is null then 'campaign_request' else 'changes_resubmitted' end as task_type,
         r.id as record_id, r.parent_campaign_id as campaign_id, m.full_name as fundraiser, r.goal as amount,
         coalesce(r.resubmitted_at, r.created_at) as submitted_at,
         r.name || case when r.parent_campaign_id is not null then ' (sub-campaign of ' || r.parent_campaign_id || ')' else '' end as summary
  from public.campaign_requests r
  left join public.managers m on m.org_id = r.org_id and m.id = r.manager_id
  where r.status = 'pending'
  union all
  select t.org_id, 'team_request:' || t.id, 'team_request', t.id, t.campaign_id, t.requested_by_email, null,
         t.created_at, coalesce(t.person_name, t.email, t.phone) || ' as ' || t.role
  from public.campaign_team_requests t where t.status = 'pending'
  union all
  select d.org_id, 'pending_payment:' || d.id, 'pending_payment', d.id, d.campaign_id, m.full_name, d.amount,
         d.created_at, coalesce(d.payment_method, 'Payment') || coalesce(' from ' || nullif(d.name, ''), '')
  from public.donations d
  left join public.campaigns c on c.org_id = d.org_id and c.id = d.campaign_id
  left join public.managers m on m.org_id = c.org_id and m.id = c.manager_id
  where d.status = 'pending' and d.deleted_at is null
  union all
  select d.org_id, 'unattributed:' || d.id, 'unattributed', d.id, null, null, d.amount,
         d.created_at, coalesce(d.payment_method, 'Payment') || coalesce(' from ' || nullif(d.name, ''), '') || coalesce(' · ref ' || d.batch_id, '')
  from public.donations d
  where d.campaign_id is null and d.status in ('completed','collect') and d.deleted_at is null
  union all
  select d.org_id, 'returned_check:' || d.id, 'returned_check', d.id, d.campaign_id, m.full_name, d.amount,
         public.org_midnight(d.reversal_date), 'Check' || coalesce(' #' || d.check_number, '') || coalesce(' from ' || nullif(d.name, ''), '') || coalesce(' · ' || d.reversal_reason, '')
  from public.donations d
  left join public.campaigns c on c.org_id = d.org_id and c.id = d.campaign_id
  left join public.managers m on m.org_id = c.org_id and m.id = c.manager_id
  where d.status = 'returned' and d.reversal_date is not null and d.deleted_at is null
  union all
  select d.org_id, 'post_dated_due:' || d.id, 'post_dated_due', d.id, d.campaign_id, m.full_name, d.amount,
         public.org_midnight(d.check_date), 'Check' || coalesce(' #' || d.check_number, '') || coalesce(' from ' || nullif(d.name, ''), '') || ' is ready to deposit'
  from public.donations d
  left join public.campaigns c on c.org_id = d.org_id and c.id = d.campaign_id
  left join public.managers m on m.org_id = c.org_id and m.id = c.manager_id
  where d.post_dated and d.check_date <= current_date and d.status = 'completed' and d.deleted_at is null
  union all
  select v.org_id, 'voucher_overdue:' || v.id || ':' || coalesce(v.expected_date::text, ''), 'voucher_overdue', v.id, v.campaign_id, m.full_name, v.remaining,
         public.org_midnight(coalesce(v.expected_date, v.date_received + 30)),
         v.id || coalesce(' · issuer #' || v.issuer_number, '') || ' · ' || replace(v.issuer, 'Voucher — ', '') || coalesce(' · ' || v.donor_name, '') || ' · face ' || v.face_value
  from public.voucher_list v
  left join public.campaigns c on c.org_id = v.org_id and c.id = v.campaign_id
  left join public.managers m on m.org_id = c.org_id and m.id = c.manager_id
  where v.overdue
  union all
  select p.org_id, 'pledge_overdue:' || p.id || ':' || coalesce(p.next_due_date, p.expected_date)::text, 'pledge_overdue', p.id, p.campaign_id, m.full_name, p.balance,
         public.org_midnight(coalesce(p.next_due_date, p.expected_date)), p.reference || coalesce(' · ' || p.donor_name, '')
  from public.pledge_list p
  left join public.campaigns c on c.org_id = p.org_id and c.id = p.campaign_id
  left join public.managers m on m.org_id = c.org_id and m.id = c.manager_id
  where p.status = 'overdue'
  union all
  select e.org_id, 'stale_check:' || e.id, 'stale_check', e.id, e.campaign_id, m.full_name, e.amount,
         e.created_at, 'Check' || coalesce(' #' || e.check_number, '') || coalesce(' to ' || nullif(e.payee, ''), '')
  from public.expenses e
  left join public.campaigns c on c.org_id = e.org_id and c.id = e.campaign_id
  left join public.managers m on m.org_id = c.org_id and m.id = c.manager_id
  where e.method = 'Check' and e.cleared is not true and e.deleted_at is null
    and not exists (select 1 from public.checks k where k.org_id = e.org_id and k.expense_id = e.id and k.status in ('voided','lost'))
    and e.created_at < now() - make_interval(days => coalesce(
      (select (s.value #>> '{}')::int from public.settings s where s.org_id = e.org_id and s.key = 'stale_check_days'), 90))
  union all
  select c.org_id, 'inactive_campaign:' || c.id || ':' || coalesce(a.last_at, c.created_at)::date, 'inactive_campaign', c.id, c.id, m.full_name, null,
         coalesce(a.last_at, c.created_at), 'No activity since ' || coalesce(a.last_at, c.created_at)::date
  from public.campaigns c
  left join public.managers m on m.org_id = c.org_id and m.id = c.manager_id
  left join lateral (
    select greatest((select max(d.created_at) from public.donations d where d.org_id = c.org_id and d.campaign_id = c.id and d.deleted_at is null),
                    (select max(e.created_at) from public.expenses e where e.org_id = c.org_id and e.campaign_id = c.id and e.deleted_at is null)) as last_at
  ) a on true
  where c.status = 'active' and c.deleted_at is null
    and coalesce(a.last_at, c.created_at) < now() - make_interval(days => coalesce(
      (select (s.value #>> '{}')::int from public.settings s where s.org_id = c.org_id and s.key = 'inactive_campaign_days'), 90))
  union all
  select c.org_id, 'bank_reassign:' || c.id, 'bank_reassign', c.id, c.id, m.full_name, null,
         a.deleted_at, 'Its bank account "' || a.name || '" was removed'
  from public.removed_accounts() a
  join public.campaigns c on c.org_id = a.org_id and c.account_id = a.id
  left join public.managers m on m.org_id = c.org_id and m.id = c.manager_id
  where c.deleted_at is null and c.status <> 'closed'
  union all
  select b.org_id, 'machine_booking:' || b.id, 'machine_booking', b.id, b.campaign_id, m.full_name, null,
         b.requested_at,
         'Machine for ' || to_char(b.booking_date, 'FMMonth FMDD, YYYY') || case when b.offered_at is not null then ' · a machine opened up' else '' end
  from public.machine_bookings b
  left join public.managers m on m.org_id = b.org_id and m.id = b.manager_id
  where b.status = 'pending' and b.booking_date >= public.org_today()
  union all
  select r.org_id, 'payout_request:' || r.id, 'payout_request', r.id, r.campaign_id, m.full_name, r.amount,
         r.created_at,
         'To ' || r.recipient_name || ' by ' || r.method || case when r.full_balance then ' · full balance' else '' end
           || case when r.source = 'phone' then ' · by phone' else '' end
  from public.payout_requests r
  left join public.managers m on m.org_id = r.org_id and m.id = r.manager_id
  where r.status = 'pending'
  union all
  select e.org_id, 'scheduled_payout:' || e.id, 'scheduled_payout', e.id, e.campaign_id, m.full_name, e.amount,
         public.org_midnight(e.scheduled_for),
         coalesce(e.method, 'Payout') || coalesce(' to ' || nullif(e.payee, ''), '') || ' was set for ' || to_char(e.scheduled_for, 'FMMonth FMDD, YYYY')
  from public.expenses e
  left join public.campaigns c on c.org_id = e.org_id and c.id = e.campaign_id
  left join public.managers m on m.org_id = c.org_id and m.id = c.manager_id
  where e.processed_at is null and e.scheduled_for <= public.org_today() and e.deleted_at is null
  union all
  select o.id, 'receipt_text_missing', 'receipt_text_missing', o.id::text, null, null, null, o.created_at,
         'Set the Hebrew and English receipt text in Settings → Receipt Text. Until then receipts leave those sections out'
  from public.organizations o
  where o.id = public.current_org_id()
    and not exists (select 1 from public.receipt_templates t where t.org_id = o.id and t.level = 'default'
                    and (t.hebrew_text is not null or t.english_text is not null))
  union all
  select r.org_id, 'receipt_reissue:' || r.id, 'receipt_reissue', r.id, r.campaign_id, m.full_name, r.amount, r.voided_at,
         r.receipt_number || ' for ' || coalesce(r.donor_name, 'a donor') || ' was voided because the donation changed'
  from public.receipts r
  left join public.campaigns c on c.org_id = r.org_id and c.id = r.campaign_id
  left join public.managers m on m.org_id = c.org_id and m.id = c.manager_id
  where r.needs_reissue and r.status = 'voided'
    and not exists (select 1 from public.receipts x where x.org_id = r.org_id and x.donation_ids && r.donation_ids and x.status = 'issued')
)
select i.task_key, i.task_type, i.record_id, i.campaign_id, c.internal_name as campaign_name, i.fundraiser, i.amount, i.submitted_at, i.summary,
       h.note as held_note, h.task_key is not null as held
from items i
left join public.campaigns c on c.org_id = i.org_id and c.id = i.campaign_id
left join lateral (
  select a.task_key, a.note from public.task_sheet_actions a
  where a.org_id = i.org_id and a.task_key = i.task_key and a.action = 'held' order by a.created_at desc limit 1
) h on true
where (select public.is_admin())
  and not exists (select 1 from public.task_sheet_actions a where a.org_id = i.org_id and a.task_key = i.task_key and a.action = 'dismissed');

-- ---------------------------------------------------------------------------
-- Row-level security and function access
-- ---------------------------------------------------------------------------
alter table public.receipt_templates enable row level security;
alter table public.receipts          enable row level security;
alter table public.tax_statements    enable row level security;
revoke all on public.receipt_templates, public.receipts, public.tax_statements from anon;
revoke insert, update, delete on public.receipt_templates, public.receipts, public.tax_statements from authenticated;

do $$
declare t text;
begin
  foreach t in array array['receipt_templates','receipts','tax_statements'] loop
    execute format('create policy org_wall on public.%I as restrictive for all to authenticated
                    using (org_id = (select public.current_org_id()))
                    with check (org_id = (select public.current_org_id()))', t);
    execute format('create trigger log_row_change after insert or update or delete on public.%I
                    for each row execute function public.log_row_change()', t);
  end loop;
end $$;

create policy admin_read on public.receipt_templates for select to authenticated using ((select public.is_admin()));
create policy primary_read on public.receipt_templates for select to authenticated
  using (level = 'default' or (level = 'campaign' and public.is_primary_on(ref_id)));
create policy admin_read on public.receipts for select to authenticated using ((select public.is_admin()));
-- Fundraisers see that a receipt went out on their campaigns' donations.
create policy manager_read on public.receipts for select to authenticated
  using (campaign_id = any((select public.my_campaign_ids())::text[]));
create policy admin_read on public.tax_statements for select to authenticated using ((select public.is_admin()));

revoke execute on function public.void_receipt_on_change() from public, anon, authenticated;
revoke execute on function public.receipt_blocker(public.donations) from public, anon, authenticated;
do $$
declare f text;
begin
  foreach f in array array[
    'save_receipt_template(text, text, text, text, text)',
    'receipt_text(text)',
    'save_check_asset(text, text, text, text, text, text, text)',
    'issue_receipt(text, numeric, date, text, text, text, text, text, text, text, text)',
    'void_receipt(text, text)',
    'correct_receipt(text, numeric, date, text, text, text, text)',
    'receipt_candidates(date, date)',
    'statement_items(text, integer, text[], text)',
    'log_tax_statement(text, integer, text[], text)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
