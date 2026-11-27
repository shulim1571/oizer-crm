-- Phase 8 part 2: a public payment page for every campaign, at the organization's address under #/give/<id>.
-- Anyone with the link can give by card through the organization's Sola account: preset or typed amounts with
-- a minimum, cover-the-fee worked out so the campaign gets exactly what the donor meant to give, the goal and
-- progress, custom fields, the giving details, an optional donor wall, and a thank-you page. A charge from the
-- page runs as nobody in particular: the donor is found by phone or email, or added. Turnstile and limits per
-- connection keep bots and card testers out. A donor asking for a receipt puts it on the Task Sheet.

-- ---------------------------------------------------------------------------
-- What a page shows, beyond the settings campaigns already have
-- ---------------------------------------------------------------------------
alter table public.campaign_page_settings
  add column page_enabled      boolean not null default true,
  add column cover_fee_enabled boolean not null default true,
  add column suggested_amount  numeric(12,2),
  add column description       text,
  add column thank_you         text,
  add column banner_url        text;

alter table public.donations
  add column fee_covered   boolean not null default false,
  add column custom_fields jsonb;

alter table public.gateway_transactions
  add column donor_info    jsonb,
  add column custom_fields jsonb,
  add column cover_fee     boolean not null default false,
  add column base_amount   numeric(12,2),
  add column public_token  text;
create unique index gateway_transactions_public_token on public.gateway_transactions (public_token) where public_token is not null;

-- Online gifts are credited to their own source.
insert into public.sources (org_id, id, name) select id, 'Online', 'Online payment page' from public.organizations on conflict do nothing;

-- Above this, the page asks the donor to confirm the amount. Set by the Super Admin.
insert into public.settings (org_id, key, value, description, updated_by)
select id, 'large_donation_confirm', '5000', 'Payment pages ask donors to confirm gifts above this amount', 'system' from public.organizations
on conflict do nothing;

-- Every campaign links to its own page unless it already has a link of its own.
create or replace function public.give_url(p_org uuid, p_campaign text) returns text
language sql stable security definer set search_path = '' as $$
  select public.portal_url(p_org) || '#/give/' || p_campaign
$$;

update public.campaigns c set payment_link = public.give_url(c.org_id, c.id)
where c.payment_link is null and c.deleted_at is null and public.portal_url(c.org_id) is not null;

create or replace function public.default_payment_link() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.payment_link is null and public.portal_url(new.org_id) is not null then
    new.payment_link := public.give_url(new.org_id, new.id);
  end if;
  return new;
end $$;
create trigger default_payment_link before insert on public.campaigns for each row execute function public.default_payment_link();

-- ---------------------------------------------------------------------------
-- Cover the fee: the smallest total whose fee leaves the campaign the full gift
-- ---------------------------------------------------------------------------
create or replace function public.cover_fee_total(p_org uuid, p_campaign text, p_amount numeric) returns numeric
language plpgsql stable security definer set search_path = '' as $$
declare v_total numeric := round(p_amount + public.calculate_fee(p_org, p_campaign, 'Credit Card', p_amount), 2); v_i int := 0;
begin
  while v_total - public.calculate_fee(p_org, p_campaign, 'Credit Card', v_total) < p_amount and v_i < 200 loop
    v_total := v_total + 0.01;
    v_i := v_i + 1;
  end loop;
  return v_total;
end $$;

-- ---------------------------------------------------------------------------
-- The page (anyone)
-- ---------------------------------------------------------------------------
create or replace function public.public_give_page(p_org uuid, p_campaign text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  c public.campaigns;
  s public.campaign_page_settings;
  o public.organizations;
  p public.payment_settings;
  v_raised numeric;
  v_fee record;
begin
  select * into c from public.campaigns where org_id = p_org and id = p_campaign and deleted_at is null and status in ('active','archived');
  if c.id is null then return null; end if;
  select * into s from public.campaign_page_settings where org_id = p_org and campaign_id = p_campaign;
  if s.campaign_id is null and c.parent_campaign_id is not null then
    select * into s from public.campaign_page_settings where org_id = p_org and campaign_id = c.parent_campaign_id;
  end if;
  if s.campaign_id is not null and not s.page_enabled then return null; end if;
  select * into o from public.organizations where id = p_org and status = 'active';
  if o.id is null then return null; end if;
  select * into p from public.payment_settings where org_id = p_org;
  if c.goal is not null then
    select coalesce(x.combined_raised, x.raised) into v_raised from public.campaign_summary x where x.org_id = p_org and x.id = p_campaign;
  end if;
  return jsonb_build_object(
    'campaign', jsonb_build_object('id', c.id, 'name', coalesce(c.external_name, c.internal_name, c.campaign_name), 'goal', c.goal, 'raised', v_raised),
    'org', jsonb_build_object('name', o.name, 'logo_url', coalesce(nullif(s.logo_url, ''), o.logo_url), 'color', coalesce(nullif(s.brand_color, ''), o.primary_color),
                              'check_payee', o.check_payee, 'zelle', o.zelle, 'ein', o.ein),
    'page', jsonb_build_object(
      'language', coalesce(s.language, 'en'), 'presets', coalesce(to_jsonb(s.preset_amounts), '[]'), 'suggested', s.suggested_amount,
      'allow_other', coalesce(s.allow_other_amount, true), 'min', s.min_donation,
      'cover_fee', coalesce(s.cover_fee_enabled, true), 'cover_fee_default', coalesce(s.cover_fee_default, false),
      'custom_fields', coalesce(s.custom_fields, '[]'), 'description', s.description, 'thank_you', s.thank_you, 'banner_url', s.banner_url,
      'donor_wall', case when coalesce(s.donor_wall, false) then (
        select coalesce(jsonb_agg(w order by w.at desc), '[]') from (
          select case when d.anonymous then null else coalesce(nullif(trim(dn.first_name || ' ' || coalesce(left(dn.last_name, 1) || '.', '')), ''), nullif(d.name, '')) end as name,
                 d.amount, d.created_at as at
          from public.donations d left join public.donors dn on dn.org_id = d.org_id and dn.id = d.donor_id
          where d.org_id = p_org and d.campaign_id = p_campaign and d.status = 'completed' and d.deleted_at is null
            and coalesce(d.payment_method, '') <> 'Opening Balance'
          order by d.created_at desc limit 50) w) end,
      'confirm_over', coalesce((select (x.value #>> '{}')::numeric from public.settings x where x.org_id = p_org and x.key = 'large_donation_confirm'), 5000)),
    'payments', jsonb_build_object('ready', p.ifields_key is not null and p.api_key is not null, 'ifields_key', p.ifields_key, 'sandbox', coalesce(p.sandbox, true))
  );
end $$;

-- What the donor pays with cover-the-fee, for the page to show as the amount changes.
create or replace function public.public_cover_fee(p_org uuid, p_campaign text, p_amount numeric) returns numeric
language sql stable security definer set search_path = '' as $$
  select case when p_amount > 0 and p_amount <= 1000000
              and exists (select 1 from public.campaigns c where c.org_id = p_org and c.id = p_campaign and c.deleted_at is null and c.status in ('active','archived'))
         then public.cover_fee_total(p_org, p_campaign, p_amount) end
$$;

-- ---------------------------------------------------------------------------
-- A gift from the page (the give function, service role)
-- ---------------------------------------------------------------------------
-- Checks the page's rules and the connection's recent attempts, then records the attempt.
create or replace function public.begin_public_sale(
  p_org uuid, p_campaign text, p_amount numeric, p_cover_fee boolean, p_donor jsonb, p_custom jsonb, p_ip text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_page jsonb := public.public_give_page(p_org, p_campaign);
  v_total numeric;
  v_id uuid;
  v_token text := encode(extensions.gen_random_bytes(18), 'hex');
  f jsonb;
  v_answer text;
begin
  if v_page is null then raise exception 'This page isn''t taking donations'; end if;
  if not (v_page #>> '{payments,ready}')::boolean then raise exception 'This page isn''t taking card donations yet'; end if;
  if p_ip is not null then
    if (select count(*) from public.gateway_transactions g where g.ip = p_ip and g.requested_by is null
          and g.status in ('declined','error') and g.created_at > now() - interval '1 hour') >= 5
       or (select count(*) from public.gateway_transactions g where g.ip = p_ip and g.requested_by is null
             and g.created_at > now() - interval '1 hour') >= 20 then
      raise exception 'Too many attempts from this connection. Please try again later';
    end if;
  end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'Choose an amount'; end if;
  if p_amount > 1000000 then raise exception 'Please call the office to give this amount'; end if;
  if (v_page #>> '{page,min}') is not null and p_amount < (v_page #>> '{page,min}')::numeric then
    raise exception 'The smallest gift here is $%', v_page #>> '{page,min}';
  end if;
  if not (v_page #>> '{page,allow_other}')::boolean and not (v_page -> 'page' -> 'presets') @> to_jsonb(round(p_amount, 2)) then
    raise exception 'Choose one of the amounts';
  end if;
  if nullif(trim(p_donor ->> 'first_name'), '') is null or nullif(trim(p_donor ->> 'last_name'), '') is null then raise exception 'Enter your first and last name'; end if;
  if public.normalize_phone(p_donor ->> 'phone') is null and length(regexp_replace(coalesce(p_donor ->> 'phone', ''), '\D', '', 'g')) < 7 then
    raise exception 'Enter your phone number';
  end if;
  if nullif(trim(p_donor ->> 'email'), '') is not null and public.normalize_address('email', p_donor ->> 'email') is null then
    raise exception 'Check your email address';
  end if;
  for f in select * from jsonb_array_elements(v_page #> '{page,custom_fields}') loop
    v_answer := p_custom ->> (f ->> 'name');
    if coalesce((f ->> 'required')::boolean, false) and (v_answer is null or trim(v_answer) = '' or v_answer = 'false') then
      raise exception '% is required', f ->> 'name';
    end if;
  end loop;
  v_total := case when p_cover_fee and (v_page #>> '{page,cover_fee}')::boolean then public.cover_fee_total(p_org, p_campaign, p_amount) else round(p_amount, 2) end;
  insert into public.gateway_transactions (org_id, invoice, kind, amount, base_amount, cover_fee, campaign_id, card_name, email, notes, ip,
                                           requested_by, requested_email, donor_info, custom_fields, public_token)
  values (p_org, public.new_invoice(), 'sale', v_total, round(p_amount, 2), coalesce(p_cover_fee, false) and v_total > p_amount, p_campaign,
          trim(p_donor ->> 'first_name') || ' ' || trim(p_donor ->> 'last_name'), nullif(trim(p_donor ->> 'email'), ''),
          nullif(left(trim(p_donor ->> 'notes'), 1000), ''), p_ip, null, 'Online payment page',
          jsonb_strip_nulls(jsonb_build_object(
            'first_name', left(trim(p_donor ->> 'first_name'), 80), 'last_name', left(trim(p_donor ->> 'last_name'), 80),
            'phone', left(trim(p_donor ->> 'phone'), 40), 'email', nullif(left(trim(p_donor ->> 'email'), 200), ''),
            'address', nullif(left(trim(p_donor ->> 'address'), 300), ''), 'country', nullif(left(trim(p_donor ->> 'country'), 40), ''))),
          nullif(p_custom, '{}'::jsonb), v_token)
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'token', v_token, 'total', v_total);
end $$;

-- The donor the page's gift belongs to: the one with this phone or email, or a new one.
create or replace function public.find_or_add_donor(p_org uuid, p_info jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare v_id text; v_phone text := regexp_replace(coalesce(p_info ->> 'phone', ''), '\D', '', 'g'); v_email text := lower(trim(p_info ->> 'email'));
begin
  select d.id into v_id from public.donors d
  where d.org_id = p_org and d.deleted_at is null
    and ((length(v_phone) >= 7 and right(regexp_replace(coalesce(d.phone, ''), '\D', '', 'g'), 10) = right(v_phone, 10))
         or (v_email <> '' and lower(trim(d.email)) = v_email))
  order by (length(v_phone) >= 7 and right(regexp_replace(coalesce(d.phone, ''), '\D', '', 'g'), 10) = right(v_phone, 10)) desc, d.created_at
  limit 1;
  if v_id is null then
    insert into public.donors (org_id, first_name, last_name, phone, email, address, created_by)
    values (p_org, p_info ->> 'first_name', p_info ->> 'last_name', p_info ->> 'phone', nullif(v_email, ''),
            concat_ws(E'\n', p_info ->> 'address', nullif(p_info ->> 'country', 'USA')), 'Online payment page')
    returning id into v_id;
  end if;
  return v_id;
end $$;

-- The donor asks for a receipt from the thank-you page; it lands on the Task Sheet for the office.
create or replace function public.request_receipt(p_token text, p_email text, p_phone text) returns void
language plpgsql security definer set search_path = '' as $$
declare g public.gateway_transactions;
begin
  select * into g from public.gateway_transactions where public_token = p_token and nullif(p_token, '') is not null and status = 'approved';
  if g.id is null then raise exception 'This link has expired'; end if;
  if g.created_at < now() - interval '30 days' then raise exception 'This link has expired'; end if;
  if nullif(trim(p_email), '') is null and nullif(trim(p_phone), '') is null then raise exception 'Enter an email address or a phone number'; end if;
  if nullif(trim(p_email), '') is not null and public.normalize_address('email', p_email) is null then raise exception 'Check the email address'; end if;
  insert into public.task_items (org_id, task_key, task_type, record_id, campaign_id, amount, summary, detail)
  values (g.org_id, 'receipt_requested:' || g.donation_id, 'receipt_requested', g.donation_id, g.campaign_id, g.amount,
          coalesce(g.card_name, 'A donor') || ' asked for a receipt by ' || concat_ws(' and ',
            case when nullif(trim(p_email), '') is not null then 'email (' || lower(trim(p_email)) || ')' end,
            case when nullif(trim(p_phone), '') is not null then 'text (' || trim(p_phone) || ')' end),
          jsonb_build_object('email', nullif(lower(trim(p_email)), ''), 'phone', nullif(trim(p_phone), '')))
  on conflict (org_id, task_key) do update set summary = excluded.summary, detail = excluded.detail, created_at = now(), resolved_at = null;
end $$;

-- ---------------------------------------------------------------------------
-- Task Sheet items that are simply rows, so new kinds no longer need the view rewritten
-- ---------------------------------------------------------------------------
create table public.task_items (
  org_id       uuid not null references public.organizations(id),
  task_key     text not null,
  task_type    text not null,
  record_id    text,
  campaign_id  text,
  amount       numeric(12,2),
  summary      text not null,
  detail       jsonb,
  created_at   timestamptz not null default now(),
  resolved_at  timestamptz,
  primary key (org_id, task_key)
);
alter table public.task_items enable row level security;
revoke all on public.task_items from anon, authenticated;
grant select on public.task_items to authenticated;
create policy org_wall on public.task_items as restrictive for all to authenticated
  using (org_id = (select public.current_org_id())) with check (org_id = (select public.current_org_id()));
create policy admin_read on public.task_items for select to authenticated using ((select public.is_admin()));

-- The Task Sheet gains the row-based items.
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
  union all
  select c.org_id, 'import_conflict:' || c.id, 'import_conflict', c.id, i.campaign_id, null, null, i.imported_at,
         coalesce(c.on_file ->> 'name', 'A donor') || ': the contact list has different details (matched by ' || c.matched_by || ')'
  from public.import_conflicts c
  join public.imports i on i.org_id = c.org_id and i.id = c.import_id
  where c.resolved_at is null and i.reversed_at is null
  union all
  select g.org_id, 'delivery_failed:' || g.id, 'delivery_failed', g.id::text, g.campaign_id, null, null, coalesce(g.failed_at, g.created_at),
         initcap(replace(g.kind, '_', ' ')) || ' by ' || case g.channel when 'sms' then 'text' else 'email' end
           || ' to ' || coalesce(g.to_name || ' (' || g.to_address || ')', g.to_address) || ': ' || coalesce(g.error, 'failed')
  from public.messages g
  where g.status = 'failed' and g.resent_as is null
  union all
  select t.org_id, t.task_key, t.task_type, t.record_id, t.campaign_id, null, t.amount, t.created_at, t.summary
  from public.task_items t
  where t.resolved_at is null
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
-- Recording Sola's answer: a gift from the page has no admin behind it
-- ---------------------------------------------------------------------------
create or replace function public.record_gateway_result(p_org uuid, p_id uuid, p_result jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  g public.gateway_transactions;
  v_result text := upper(left(coalesce(p_result ->> 'xResult', ''), 1));
  v_status text;
  v_donation text;
  v_card uuid;
  v_donor text;
  v_masked text := p_result ->> 'xMaskedCardNumber';
  v_online boolean;
begin
  select * into g from public.gateway_transactions where org_id = p_org and id = p_id for update;
  if g.id is null then raise exception 'Transaction not found'; end if;
  if g.status <> 'pending' then return to_jsonb(g) - 'response'; end if;
  v_status := case v_result when 'A' then 'approved' when 'D' then 'declined' else 'error' end;
  v_online := g.requested_by is null;
  if not v_online then perform public.act_as_user(p_org, g.requested_by); end if;

  if g.kind = 'sale' then
    v_donor := g.donor_id;
    if v_online and v_status = 'approved' and g.donor_info is not null then
      v_donor := public.find_or_add_donor(p_org, g.donor_info);
    end if;
    insert into public.donations (org_id, campaign_id, donor_id, amount, type, status, payment_method, source, gateway_id,
                                  name, email, phone, notes, created_by, fee_covered, custom_fields)
    values (p_org, g.campaign_id, v_donor, g.amount, 'Payment', case when v_status = 'approved' then 'completed' else 'failed' end,
            'Credit Card', case when v_online then 'Online' else 'Manual' end, p_result ->> 'xRefNum',
            coalesce(g.card_name, (select dn.display_name from public.donors dn where dn.org_id = p_org and dn.id = g.donor_id)),
            g.email, g.donor_info ->> 'phone',
            concat_ws(' · ', g.notes,
              case when v_masked is not null then coalesce(p_result ->> 'xCardType', 'Card') || ' ' || right(v_masked, 4) end,
              case when g.cover_fee then 'Donor covered the fee' end,
              case when v_status <> 'approved' then 'Declined: ' || coalesce(nullif(p_result ->> 'xError', ''), 'no reason given') end,
              case when v_online and v_status <> 'approved' then 'IP ' || g.ip end),
            g.requested_email, g.cover_fee, g.custom_fields)
    returning id into v_donation;
    if v_status = 'approved' and g.save_card and nullif(p_result ->> 'xToken', '') is not null then
      insert into public.donor_cards (org_id, donor_id, token, masked, card_type, exp, name, created_by)
      values (p_org, g.donor_id, extensions.pgp_sym_encrypt(p_result ->> 'xToken', public.payment_keys_key()), v_masked,
              p_result ->> 'xCardType', p_result ->> 'xExp', g.card_name, g.requested_email)
      returning id into v_card;
    end if;
  elsif v_status = 'approved' and g.kind = 'void' then
    update public.donations set status = 'voided', reversal_date = current_date, reversal_reason = 'Voided at Sola',
           reversal_notes = 'Sola ref ' || coalesce(p_result ->> 'xRefNum', '')
    where org_id = p_org and id = g.donation_id;
  elsif v_status = 'approved' and g.kind = 'refund' then
    perform public.refund_donation(g.donation_id, current_date, 'Credit Card', 'Refunded at Sola, ref ' || coalesce(p_result ->> 'xRefNum', ''));
  end if;

  update public.gateway_transactions set
    status = v_status, finished_at = now(),
    ref_num = p_result ->> 'xRefNum', auth_code = p_result ->> 'xAuthCode',
    card_type = coalesce(p_result ->> 'xCardType', card_type), masked_card = coalesce(v_masked, masked_card),
    error = nullif(p_result ->> 'xError', ''), error_code = nullif(p_result ->> 'xErrorCode', ''),
    donation_id = coalesce(v_donation, donation_id), card_id = coalesce(v_card, card_id), donor_id = coalesce(v_donor, donor_id),
    response = p_result - 'xToken' - 'xCardNum' - 'xCVV' - 'xKey'
  where org_id = p_org and id = p_id
  returning * into g;
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.headers', '', true);
  return to_jsonb(g) - 'response';
end $$;

-- Page content, set by an admin or the campaign's primary fundraiser.
create or replace function public.save_page_content(
  p_campaign text, p_page_enabled boolean, p_cover_fee_enabled boolean, p_suggested numeric,
  p_description text, p_thank_you text, p_banner_url text
) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  if not public.is_admin() and not public.is_primary_on(p_campaign) then
    raise exception 'Only an admin or the campaign''s primary fundraiser can change the payment page';
  end if;
  if not exists (select 1 from public.campaigns c where c.org_id = v_org and c.id = p_campaign and c.deleted_at is null) then
    raise exception 'Campaign not found';
  end if;
  if nullif(trim(p_banner_url), '') is not null and trim(p_banner_url) !~ '^https://' then raise exception 'The banner must be an https:// address'; end if;
  insert into public.campaign_page_settings (org_id, campaign_id, page_enabled, cover_fee_enabled, suggested_amount, description, thank_you, banner_url)
  values (v_org, p_campaign, coalesce(p_page_enabled, true), coalesce(p_cover_fee_enabled, true), p_suggested,
          nullif(trim(p_description), ''), nullif(trim(p_thank_you), ''), nullif(trim(p_banner_url), ''))
  on conflict (org_id, campaign_id) do update set page_enabled = excluded.page_enabled, cover_fee_enabled = excluded.cover_fee_enabled,
    suggested_amount = excluded.suggested_amount, description = excluded.description, thank_you = excluded.thank_you,
    banner_url = excluded.banner_url, updated_by = public.current_email(), updated_at = now();
end $$;

-- Admin: takes a row-based Task Sheet item off once handled.
create or replace function public.resolve_task_item(p_key text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_admin();
  update public.task_items set resolved_at = now() where org_id = public.current_org_id() and task_key = p_key and resolved_at is null;
end $$;

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------
create trigger log_row_change after insert or update on public.task_items for each row execute function public.log_row_change();

do $$
declare f text;
begin
  foreach f in array array['give_url(uuid, text)', 'default_payment_link()', 'cover_fee_total(uuid, text, numeric)',
                           'begin_public_sale(uuid, text, numeric, boolean, jsonb, jsonb, text)', 'find_or_add_donor(uuid, jsonb)',
                           'record_gateway_result(uuid, uuid, jsonb)'] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
  foreach f in array array['begin_public_sale(uuid, text, numeric, boolean, jsonb, jsonb, text)', 'record_gateway_result(uuid, uuid, jsonb)'] loop
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
  foreach f in array array['public_give_page(uuid, text)', 'public_cover_fee(uuid, text, numeric)', 'request_receipt(text, text, text)'] loop
    execute format('revoke execute on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
  foreach f in array array['save_page_content(text, boolean, boolean, numeric, text, text, text)', 'resolve_task_item(text)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
