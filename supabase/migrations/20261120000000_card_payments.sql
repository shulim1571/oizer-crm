-- Phase 8 part 1: cards through Sola Payments, each organization with its own Sola account. Card numbers
-- never reach us: Sola's iFields turn them into single-use tokens in the browser, and the payments Edge
-- Function charges with the organization's API key, which only that function can read. Every attempt is a
-- gateway transaction: approved sales become completed donations, declines are kept as failed ones, and
-- voids and refunds go through Sola before the donation changes. Cards can be saved on the donor as Sola
-- tokens. Sola's webhook confirms results and finishes any charge whose answer we never got.

-- ---------------------------------------------------------------------------
-- Each organization's Sola keys. The API key and webhook PIN are encrypted.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'payment_keys_key') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'base64'), 'payment_keys_key', 'Encrypts payment processor keys and saved card tokens');
  end if;
end $$;

create or replace function public.payment_keys_key() returns text
language sql stable security definer set search_path = '' as $$
  select s.decrypted_secret from vault.decrypted_secrets s where s.name = 'payment_keys_key'
$$;

create table public.payment_settings (
  org_id       uuid primary key default public.current_org_id() references public.organizations(id),
  ifields_key  text,
  api_key      bytea,
  webhook_pin  bytea,
  sandbox      boolean not null default true,
  updated_by   text default public.current_email(),
  updated_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Gateway transactions, saved cards and webhook events
-- ---------------------------------------------------------------------------
create table public.gateway_transactions (
  org_id         uuid not null default public.current_org_id() references public.organizations(id),
  id             uuid not null default gen_random_uuid(),
  invoice        text not null,
  kind           text not null check (kind in ('sale','void','refund')),
  status         text not null default 'pending' check (status in ('pending','approved','declined','error')),
  amount         numeric(12,2) not null check (amount > 0),
  campaign_id    text,
  donor_id       text,
  donation_id    text,
  card_id        uuid,
  save_card      boolean not null default false,
  card_name      text,
  email          text,
  notes          text,
  ref_num        text,
  original_ref   text,
  auth_code      text,
  card_type      text,
  masked_card    text,
  error          text,
  error_code     text,
  response       jsonb,
  ip             text,
  requested_by   uuid default auth.uid(),
  requested_email text default public.current_email(),
  created_at     timestamptz not null default now(),
  attempted_at   timestamptz,
  finished_at    timestamptz,
  primary key (org_id, id),
  unique (org_id, invoice)
);
create index on public.gateway_transactions (org_id, donation_id);
create index on public.gateway_transactions (org_id, ref_num);

create table public.donor_cards (
  org_id      uuid not null default public.current_org_id() references public.organizations(id),
  id          uuid not null default gen_random_uuid(),
  donor_id    text not null,
  token       bytea not null,
  masked      text,
  card_type   text,
  exp         text,
  name        text,
  created_by  text default public.current_email(),
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  deleted_by  text,
  primary key (org_id, id),
  foreign key (org_id, donor_id) references public.donors (org_id, id)
);

create table public.gateway_events (
  org_id       uuid not null references public.organizations(id),
  id           bigint generated always as identity,
  ref_num      text,
  invoice      text,
  command      text,
  result       text,
  amount       numeric(12,2),
  payload      jsonb not null,
  received_at  timestamptz not null default now(),
  primary key (org_id, id)
);
create index on public.gateway_events (org_id, ref_num);

-- ---------------------------------------------------------------------------
-- Settings (Super Admin)
-- ---------------------------------------------------------------------------
-- A key left empty keeps the one on file. The PIN signs Sola's webhook: letters and numbers, 15 or more.
create or replace function public.save_payment_settings(p_ifields_key text, p_api_key text, p_webhook_pin text, p_sandbox boolean)
returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_key text := public.payment_keys_key();
begin
  if not public.is_super_admin() then raise exception 'Only the Super Admin can change the payment keys'; end if;
  if nullif(trim(p_webhook_pin), '') is not null and trim(p_webhook_pin) !~ '^[A-Za-z0-9]{15,}$' then
    raise exception 'The webhook PIN must be at least 15 letters and numbers';
  end if;
  insert into public.payment_settings (org_id, ifields_key, api_key, webhook_pin, sandbox, updated_by, updated_at)
  values (v_org, nullif(trim(p_ifields_key), ''),
          case when nullif(trim(p_api_key), '') is not null then extensions.pgp_sym_encrypt(trim(p_api_key), v_key) end,
          case when nullif(trim(p_webhook_pin), '') is not null then extensions.pgp_sym_encrypt(trim(p_webhook_pin), v_key) end,
          coalesce(p_sandbox, true), public.current_email(), now())
  on conflict (org_id) do update set
    ifields_key = excluded.ifields_key,
    api_key = coalesce(excluded.api_key, payment_settings.api_key),
    webhook_pin = coalesce(excluded.webhook_pin, payment_settings.webhook_pin),
    sandbox = excluded.sandbox, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  perform public.write_activity(v_org, 'payment_keys_changed', 'payment_settings', v_org::text, null,
    jsonb_build_object('ifields_key_set', nullif(trim(p_ifields_key), '') is not null, 'api_key_changed', nullif(trim(p_api_key), '') is not null,
                       'pin_changed', nullif(trim(p_webhook_pin), '') is not null, 'sandbox', p_sandbox));
end $$;

-- What the screens need: the public iFields key and whether the secret parts are on file. Never the secrets.
create or replace function public.payment_config()
returns table (ifields_key text, sandbox boolean, api_key_set boolean, pin_set boolean, updated_at timestamptz, updated_by text)
language sql stable security definer set search_path = '' as $$
  select s.ifields_key, s.sandbox, s.api_key is not null, s.webhook_pin is not null, s.updated_at, s.updated_by
  from public.payment_settings s
  where s.org_id = public.current_org_id() and public.is_admin()
$$;

-- ---------------------------------------------------------------------------
-- Starting a charge, a void or a refund (admins, as themselves)
-- ---------------------------------------------------------------------------
create or replace function public.new_invoice() returns text
language sql volatile as $$ select 'OZ' || upper(encode(extensions.gen_random_bytes(6), 'hex')) $$;

create or replace function public.begin_card_sale(
  p_campaign text, p_donor text, p_amount numeric, p_card uuid default null, p_save_card boolean default false,
  p_name text default null, p_email text default null, p_notes text default null, p_ip text default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_id uuid; v_status text;
begin
  perform public.require_admin();
  if not exists (select 1 from public.payment_settings s where s.org_id = v_org and s.api_key is not null and s.ifields_key is not null) then
    raise exception 'Card payments aren''t set up yet. The Super Admin adds the Sola keys under Settings → Payments';
  end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'Enter an amount'; end if;
  if p_amount > 100000 then raise exception 'Charge up to $100,000 at a time'; end if;
  select c.status into v_status from public.campaigns c where c.org_id = v_org and c.id = p_campaign and c.deleted_at is null;
  if v_status is null then raise exception 'Choose a campaign'; end if;
  if v_status = 'closed' then raise exception 'Campaign % is closed', p_campaign; end if;
  if p_card is not null and not exists (select 1 from public.donor_cards k where k.org_id = v_org and k.id = p_card and k.donor_id = p_donor and k.deleted_at is null) then
    raise exception 'That saved card isn''t on this donor';
  end if;
  if p_save_card and p_donor is null then raise exception 'Choose the donor to save the card on'; end if;
  insert into public.gateway_transactions (org_id, invoice, kind, amount, campaign_id, donor_id, card_id, save_card, card_name, email, notes, ip)
  values (v_org, public.new_invoice(), 'sale', round(p_amount, 2), p_campaign, p_donor, p_card, coalesce(p_save_card, false) and p_card is null,
          nullif(trim(p_name), ''), nullif(trim(p_email), ''), nullif(trim(p_notes), ''), p_ip)
  returning id into v_id;
  return v_id;
end $$;

-- A void cancels a charge that hasn't settled; a refund returns a settled one in full.
create or replace function public.begin_card_reversal(p_donation text, p_kind text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); d public.donations; g public.gateway_transactions; v_id uuid;
begin
  perform public.require_admin();
  if p_kind not in ('void','refund') then raise exception 'Choose void or refund'; end if;
  select * into d from public.donations where org_id = v_org and id = p_donation and deleted_at is null;
  if d.id is null then raise exception 'Transaction not found'; end if;
  if d.status not in ('completed','collect') then raise exception 'Only a completed card payment can be voided or refunded'; end if;
  select * into g from public.gateway_transactions
  where org_id = v_org and donation_id = p_donation and kind = 'sale' and status = 'approved' order by created_at desc limit 1;
  if g.id is null then raise exception 'This payment didn''t go through Sola, so mark it refunded instead'; end if;
  if exists (select 1 from public.gateway_transactions x where x.org_id = v_org and x.donation_id = p_donation and x.kind in ('void','refund')
             and (x.status = 'approved' or (x.status = 'pending' and x.created_at > now() - interval '2 minutes'))) then
    raise exception 'This payment is already being voided or refunded';
  end if;
  insert into public.gateway_transactions (org_id, invoice, kind, amount, campaign_id, donor_id, donation_id, original_ref, card_type, masked_card)
  values (v_org, public.new_invoice(), p_kind, d.amount, d.campaign_id, d.donor_id, d.id, g.ref_num, g.card_type, g.masked_card)
  returning id into v_id;
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- For the payments function (service role only)
-- ---------------------------------------------------------------------------
-- Hands the function one transaction, once, with the organization's key and any saved card token.
create or replace function public.claim_gateway_request(p_org uuid, p_id uuid)
returns table (kind text, invoice text, amount numeric, api_key text, sandbox boolean, card_token text, original_ref text,
               card_name text, email text, campaign_label text, save_card boolean)
language plpgsql security definer set search_path = '' as $$
declare g public.gateway_transactions; v_key text := public.payment_keys_key();
begin
  update public.gateway_transactions set attempted_at = now()
  where org_id = p_org and id = p_id and status = 'pending' and attempted_at is null
  returning * into g;
  if g.id is null then raise exception 'This payment was already sent'; end if;
  return query
    select g.kind, g.invoice, g.amount, extensions.pgp_sym_decrypt(s.api_key, v_key), s.sandbox,
           (select extensions.pgp_sym_decrypt(k.token, v_key) from public.donor_cards k where k.org_id = p_org and k.id = g.card_id and k.deleted_at is null),
           g.original_ref, g.card_name, g.email, public.campaign_label(p_org, g.campaign_id), g.save_card
    from public.payment_settings s where s.org_id = p_org;
end $$;

-- Runs what follows as the admin who started the transaction, so donations and refunds are recorded
-- and logged under their name, with all the usual rules.
create or replace function public.act_as_user(p_org uuid, p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_email text;
begin
  select u.email into v_email from auth.users u where u.id = p_user;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'email', v_email, 'role', 'authenticated')::text, true);
  perform set_config('request.headers', jsonb_build_object('x-org-id', p_org)::text, true);
end $$;

-- Sola's answer. p_result holds the response fields (xResult, xRefNum, xError, ...), never the card token
-- except as xToken for saving. An approved sale becomes a donation; a decline is kept as a failed one.
create or replace function public.record_gateway_result(p_org uuid, p_id uuid, p_result jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  g public.gateway_transactions;
  v_result text := upper(left(coalesce(p_result ->> 'xResult', ''), 1));
  v_status text;
  v_donation text;
  v_card uuid;
  v_masked text := p_result ->> 'xMaskedCardNumber';
begin
  select * into g from public.gateway_transactions where org_id = p_org and id = p_id for update;
  if g.id is null then raise exception 'Transaction not found'; end if;
  if g.status <> 'pending' then return to_jsonb(g) - 'response'; end if;
  v_status := case v_result when 'A' then 'approved' when 'D' then 'declined' else 'error' end;
  perform public.act_as_user(p_org, g.requested_by);

  if g.kind = 'sale' then
    insert into public.donations (org_id, campaign_id, donor_id, amount, type, status, payment_method, source, gateway_id,
                                  name, email, notes, created_by)
    values (p_org, g.campaign_id, g.donor_id, g.amount, 'Payment', case when v_status = 'approved' then 'completed' else 'failed' end,
            'Credit Card', 'Manual', p_result ->> 'xRefNum',
            coalesce(g.card_name, (select dn.display_name from public.donors dn where dn.org_id = p_org and dn.id = g.donor_id)),
            g.email,
            concat_ws(' · ', g.notes,
              case when v_masked is not null then coalesce(p_result ->> 'xCardType', 'Card') || ' ' || right(v_masked, 4) end,
              case when v_status <> 'approved' then 'Declined: ' || coalesce(nullif(p_result ->> 'xError', ''), 'no reason given') end),
            g.requested_email)
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
    donation_id = coalesce(v_donation, donation_id), card_id = coalesce(v_card, card_id),
    response = p_result - 'xToken' - 'xCardNum' - 'xCVV' - 'xKey'
  where org_id = p_org and id = p_id
  returning * into g;
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.headers', '', true);
  return to_jsonb(g) - 'response';
end $$;

-- What Sola's webhook said. If a charge of ours is still waiting for its answer (the function lost the
-- connection), the webhook's answer finishes it.
create or replace function public.record_gateway_event(p_org uuid, p_payload jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_invoice text := p_payload ->> 'xInvoice';
  v_ref text := p_payload ->> 'xRefNum';
  v_result text := coalesce(nullif(p_payload ->> 'xResult', ''), left(coalesce(p_payload ->> 'xResponseResult', p_payload ->> 'xStatus', ''), 1));
  g public.gateway_transactions;
begin
  if exists (select 1 from public.gateway_events e where e.org_id = p_org and e.ref_num = v_ref and e.command is not distinct from p_payload ->> 'xCommand') then
    return;
  end if;
  insert into public.gateway_events (org_id, ref_num, invoice, command, result, amount, payload)
  values (p_org, v_ref, v_invoice, p_payload ->> 'xCommand', v_result, nullif(p_payload ->> 'xAmount', '')::numeric,
          p_payload - 'xToken' - 'xCardNum' - 'xCVV');
  select * into g from public.gateway_transactions
  where org_id = p_org and invoice = v_invoice and status = 'pending' and attempted_at < now() - interval '1 minute';
  if g.id is not null then
    perform public.record_gateway_result(p_org, g.id, jsonb_build_object(
      'xResult', v_result, 'xRefNum', v_ref, 'xError', p_payload ->> 'xError', 'xErrorCode', p_payload ->> 'xErrorCode',
      'xMaskedCardNumber', p_payload ->> 'xMaskedCardNumber', 'xCardType', p_payload ->> 'xCardType',
      'xAuthCode', p_payload ->> 'xAuthCode', 'xToken', p_payload ->> 'xToken', 'xExp', p_payload ->> 'xExp'));
  end if;
end $$;

-- The organization's webhook PIN, to check Sola's signature.
create or replace function public.gateway_webhook_pin(p_org uuid) returns text
language sql stable security definer set search_path = '' as $$
  select extensions.pgp_sym_decrypt(s.webhook_pin, public.payment_keys_key()) from public.payment_settings s where s.org_id = p_org
$$;

-- ---------------------------------------------------------------------------
-- Saved cards and the gateway log (admins)
-- ---------------------------------------------------------------------------
create or replace function public.donor_saved_cards(p_donor text)
returns table (id uuid, masked text, card_type text, exp text, name text, created_by text, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select k.id, k.masked, k.card_type, k.exp, k.name, k.created_by, k.created_at
  from public.donor_cards k
  where public.is_admin() and k.org_id = public.current_org_id() and k.donor_id = p_donor and k.deleted_at is null
  order by k.created_at desc
$$;

create or replace function public.delete_donor_card(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_admin();
  update public.donor_cards set deleted_at = now(), deleted_by = public.current_email(), token = '\x'::bytea
  where org_id = public.current_org_id() and id = p_id and deleted_at is null;
  if not found then raise exception 'Card not found'; end if;
end $$;

-- A donation's trip through Sola, for its detail panel.
create or replace function public.donation_gateway(p_donation text)
returns table (id uuid, kind text, status text, amount numeric, ref_num text, masked_card text, card_type text, error text,
               requested_email text, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select g.id, g.kind, g.status, g.amount, g.ref_num, g.masked_card, g.card_type, g.error, g.requested_email, g.created_at
  from public.gateway_transactions g
  where public.is_admin() and g.org_id = public.current_org_id() and g.donation_id = p_donation
  order by g.created_at
$$;

-- ---------------------------------------------------------------------------
-- Row-level security, logging and access
-- ---------------------------------------------------------------------------
alter table public.payment_settings     enable row level security;
alter table public.gateway_transactions enable row level security;
alter table public.donor_cards          enable row level security;
alter table public.gateway_events       enable row level security;
revoke all on public.payment_settings, public.gateway_transactions, public.donor_cards, public.gateway_events from anon, authenticated;
grant select on public.gateway_transactions to authenticated;
create policy org_wall on public.gateway_transactions as restrictive for all to authenticated
  using (org_id = (select public.current_org_id())) with check (org_id = (select public.current_org_id()));
create policy admin_read on public.gateway_transactions for select to authenticated using ((select public.is_admin()));
revoke select (response) on public.gateway_transactions from authenticated;

create trigger log_row_change after insert or update or delete on public.gateway_transactions for each row execute function public.log_row_change();
create trigger log_row_change after insert or update on public.donor_cards for each row execute function public.log_row_change();

do $$
declare f text;
begin
  foreach f in array array[
    'payment_keys_key()', 'claim_gateway_request(uuid, uuid)', 'act_as_user(uuid, uuid)', 'record_gateway_result(uuid, uuid, jsonb)',
    'record_gateway_event(uuid, jsonb)', 'gateway_webhook_pin(uuid)', 'new_invoice()'
  ] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
  foreach f in array array['claim_gateway_request(uuid, uuid)', 'record_gateway_result(uuid, uuid, jsonb)', 'record_gateway_event(uuid, jsonb)', 'gateway_webhook_pin(uuid)'] loop
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
  foreach f in array array[
    'save_payment_settings(text, text, text, boolean)', 'payment_config()',
    'begin_card_sale(text, text, numeric, uuid, boolean, text, text, text, text)', 'begin_card_reversal(text, text)',
    'donor_saved_cards(text)', 'delete_donor_card(uuid)', 'donation_gateway(text)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
