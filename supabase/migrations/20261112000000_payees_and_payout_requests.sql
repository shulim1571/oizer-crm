-- Phase 6, part 1: payee profiles, payout requests with encrypted bank details, approval, scheduled payouts and
-- payout methods. Payee details are kept from fundraisers who may not see them, while balances still count
-- every payout. Checks print in part 2; notifications arrive with Phase 7.
-- The migration fails at the end if any campaign's numbers changed.

create temp table _balances_before as
  select org_id, id, raised, fees, expenses, balance, pending_balance from public.campaign_summary;

-- ---------------------------------------------------------------------------
-- Payout methods. The standard ones for every organization; the Super Admin adds custom ones.
-- ---------------------------------------------------------------------------
create table public.payout_methods (
  id          text not null default public.short_id(),
  org_id      uuid not null default public.current_org_id() references public.organizations(id),
  name        text not null check (trim(name) <> ''),
  description text,
  notes       text,
  is_custom   boolean not null default true,
  active      boolean not null default true,
  created_by  text default public.current_email(),
  created_at  timestamptz not null default now(),
  primary key (org_id, id)
);
create unique index payout_methods_name on public.payout_methods (org_id, lower(name));

create or replace function public.seed_payout_methods(p_org uuid) returns void
language sql security definer set search_path = '' as $$
  insert into public.payout_methods (org_id, name, is_custom, created_by)
  select p_org, x, false, 'system'
  from unnest(array['ACH','Zelle','Check','Wire','Account Transfer','Cash','Credit Card']) x
  on conflict do nothing
$$;
select public.seed_payout_methods(o.id) from public.organizations o;

create or replace function public.org_payout_methods() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform public.seed_payout_methods(new.id);
  return new;
end $$;
create trigger seed_payout_methods after insert on public.organizations
  for each row execute function public.org_payout_methods();

create or replace function public.save_payout_method(p_id text, p_name text, p_description text default null, p_notes text default null, p_active boolean default true) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  m public.payout_methods;
  v_id text := p_id;
begin
  if not public.is_super_admin() then raise exception 'Only the Super Admin can set up payout methods'; end if;
  if nullif(trim(p_name), '') is null then raise exception 'Give the method a name'; end if;
  if exists (select 1 from public.payout_methods x where x.org_id = v_org and lower(x.name) = lower(trim(p_name)) and x.id is distinct from p_id) then
    raise exception 'There is already a payout method called %', trim(p_name);
  end if;
  if p_id is null then
    insert into public.payout_methods (org_id, name, description, notes, is_custom, active)
    values (v_org, trim(p_name), nullif(trim(p_description), ''), nullif(trim(p_notes), ''), true, coalesce(p_active, true))
    returning id into v_id;
  else
    select * into m from public.payout_methods where org_id = v_org and id = p_id;
    if m.id is null then raise exception 'Payout method not found'; end if;
    if not m.is_custom then raise exception 'The standard payout methods can''t be changed'; end if;
    update public.payout_methods
    set name = trim(p_name), description = nullif(trim(p_description), ''), notes = nullif(trim(p_notes), ''), active = coalesce(p_active, true)
    where org_id = v_org and id = p_id;
  end if;
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- Payees: separate from donors, one profile per person or business paid
-- ---------------------------------------------------------------------------
create table public.payees (
  id               text not null default public.short_id(),
  org_id           uuid not null default public.current_org_id() references public.organizations(id),
  name             text not null check (trim(name) <> ''),
  address          text,
  phone            text,
  email            text,
  preferred_method text,
  notes            text,
  merged_into      text,
  created_by       text default public.current_email(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (org_id, id)
);
create index payees_org_name_idx on public.payees (org_id, lower(name));
create index payees_org_merged_idx on public.payees (org_id, merged_into);

-- Admin only. A flagged payee can still be chosen; the warning shows when an admin approves.
create table public.payee_flags (
  org_id     uuid not null default public.current_org_id() references public.organizations(id),
  payee_id   text not null,
  reason     text,
  flagged_by text default public.current_email(),
  flagged_at timestamptz not null default now(),
  primary key (org_id, payee_id),
  foreign key (org_id, payee_id) references public.payees (org_id, id)
);

-- Admin only, permanent: why requests to this payee were turned down.
create table public.payee_notes (
  id         text not null default public.short_id(),
  org_id     uuid not null default public.current_org_id() references public.organizations(id),
  payee_id   text not null,
  request_id text,
  note       text not null,
  created_by text default public.current_email(),
  created_at timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, payee_id) references public.payees (org_id, id)
);
create index payee_notes_org_payee_idx on public.payee_notes (org_id, payee_id);

create table public.payee_merges (
  id            text not null default public.short_id(),
  org_id        uuid not null references public.organizations(id),
  kept_id       text not null,
  absorbed_id   text not null,
  absorbed_name text,
  merged_by     text default public.current_email(),
  merged_at     timestamptz not null default now(),
  primary key (org_id, id)
);

-- ---------------------------------------------------------------------------
-- Payouts (the expenses table) gain a payee, a schedule and a reference
-- ---------------------------------------------------------------------------
alter table public.expenses
  add column payee_id      text,
  add column request_id    text,
  add column scheduled_for date,
  add column processed_at  timestamptz,
  add column reference     text,
  add constraint expenses_payee_fkey foreign key (org_id, payee_id) references public.payees (org_id, id) on update cascade;
create index expenses_org_payee_idx on public.expenses (org_id, payee_id);
create index expenses_org_request_idx on public.expenses (org_id, request_id);
create index expenses_org_unprocessed_idx on public.expenses (org_id, scheduled_for) where processed_at is null;

-- Every name already paid becomes a profile, matched without regard to case or spacing.
insert into public.payees (org_id, name, created_by, created_at)
select org_id, min(trim(payee)), 'migration', min(created_at)
from public.expenses where nullif(trim(payee), '') is not null
group by org_id, lower(trim(payee));
update public.expenses e set payee_id = p.id
from public.payees p
where p.org_id = e.org_id and lower(p.name) = lower(trim(e.payee)) and nullif(trim(e.payee), '') is not null;
update public.expenses set processed_at = created_at;

-- Links a payout to its payee, making a profile the first time a name is paid. A payout dated ahead
-- waits as scheduled; its money leaves the balance at once.
create or replace function public.payout_rules() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_name text;
begin
  if new.payee_id is not null and (tg_op = 'INSERT' or new.payee_id is distinct from old.payee_id) then
    select p.name into v_name from public.payees p where p.org_id = new.org_id and p.id = new.payee_id and p.merged_into is null;
    if v_name is null then raise exception 'Payee not found'; end if;
    new.payee := v_name;
  elsif new.payee_id is null and nullif(trim(new.payee), '') is not null
        and (tg_op = 'INSERT' or new.payee is distinct from old.payee) then
    select p.id into new.payee_id from public.payees p
    where p.org_id = new.org_id and p.merged_into is null and lower(p.name) = lower(trim(new.payee))
    order by p.created_at limit 1;
    if new.payee_id is null then
      insert into public.payees (org_id, name, preferred_method) values (new.org_id, trim(new.payee), new.method)
      returning id into new.payee_id;
    end if;
  end if;
  if new.method is not null and (tg_op = 'INSERT' or new.method is distinct from old.method)
     and not exists (select 1 from public.payout_methods m where m.org_id = new.org_id and m.active and lower(m.name) = lower(new.method)) then
    raise exception 'Choose one of the payout methods. The Super Admin can add others in Settings';
  end if;
  if tg_op = 'INSERT' then
    new.processed_at := case when new.scheduled_for > public.org_today() then null else coalesce(new.processed_at, now()) end;
  end if;
  return new;
end $$;
create trigger payout_rules before insert or update on public.expenses
  for each row execute function public.payout_rules();

create or replace function public.process_scheduled_payout(p_payout text, p_reference text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_admin();
  update public.expenses set processed_at = now(), reference = coalesce(nullif(trim(p_reference), ''), reference)
  where org_id = public.current_org_id() and id = p_payout and processed_at is null and deleted_at is null;
  if not found then raise exception 'This payout was already processed or cancelled'; end if;
end $$;

-- ---------------------------------------------------------------------------
-- Who sees what. The primary fundraiser, and anyone given payout rights, sees who was paid.
-- Other fundraisers on the campaign see only the amount and date.
-- ---------------------------------------------------------------------------
create or replace function public.can_see_payout_detail(p_campaign text) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_admin() or public.is_primary_on(p_campaign)
      or public.has_override('payout_visibility', p_campaign) or public.has_override('request_payouts', p_campaign)
$$;

create or replace function public.can_request_payout(p_campaign text) returns boolean
language sql stable security definer set search_path = '' as $$
  select (public.is_primary_on(p_campaign) or public.has_override('request_payouts', p_campaign))
     and exists (select 1 from public.campaigns c where c.org_id = public.current_org_id() and c.id = p_campaign
                 and c.deleted_at is null and c.status <> 'closed' and c.balance_mode <> 'shared')
$$;

drop policy manager_read on public.expenses;
create policy manager_read on public.expenses for select to authenticated
  using (campaign_id = any((select public.my_campaign_ids())::text[]) and public.can_see_payout_detail(campaign_id));

-- Balances have to count payouts a fundraiser can't open.
create or replace function public.campaign_expense_totals()
returns table (org_id uuid, campaign_id text, expenses numeric)
language sql stable security definer set search_path = '' as $$
  select x.org_id, x.campaign_id, sum(x.amount)
  from public.expenses x
  where x.deleted_at is null
    and (auth.uid() is null
         or (x.org_id = public.current_org_id()
             and (public.is_admin() or x.campaign_id = any(public.my_campaign_ids()) or x.campaign_id = any(public.my_guest_campaign_ids()))))
  group by x.org_id, x.campaign_id
$$;

-- Every payout on a campaign the caller is on, with the payee only for those allowed to see it.
create or replace function public.campaign_payouts(p_campaign text)
returns table (id text, campaign_id text, amount numeric, created_at timestamptz, processed_at timestamptz, scheduled_for date,
               payee text, payee_id text, method text, check_number text, memo text, reference text, detail boolean)
language plpgsql stable security definer set search_path = '' as $$
declare v_detail boolean := public.can_see_payout_detail(p_campaign);
begin
  if not (public.is_admin() or p_campaign = any(public.my_campaign_ids())) then
    raise exception 'That campaign isn''t yours';
  end if;
  return query
  select e.id, e.campaign_id, e.amount, e.created_at, e.processed_at, e.scheduled_for,
         case when v_detail then e.payee end, case when v_detail then e.payee_id end,
         case when v_detail then e.method end, case when v_detail then e.check_number end,
         case when v_detail then e.memo end, case when v_detail then e.reference end, v_detail
  from public.expenses e
  where e.org_id = public.current_org_id() and e.campaign_id = p_campaign and e.deleted_at is null
  order by e.created_at desc;
end $$;

-- ---------------------------------------------------------------------------
-- Payout requests. Bank details are encrypted with a key kept in the Vault, and only admins can read them.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'payout_details_key') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'base64'), 'payout_details_key', 'Encrypts bank and Zelle details on payout requests');
  end if;
end $$;

create or replace function public.payout_key() returns text
language sql stable security definer set search_path = '' as $$
  select s.decrypted_secret from vault.decrypted_secrets s where s.name = 'payout_details_key'
$$;

create table public.payout_requests (
  id             text not null default public.short_id(),
  org_id         uuid not null default public.current_org_id() references public.organizations(id),
  campaign_id    text not null,
  manager_id     text,
  requested_by   text default public.current_email(),
  source         text not null default 'portal' check (source in ('portal','phone')),
  amount         numeric(12,2) check (amount > 0),
  full_balance   boolean not null default false,
  recipient_name text not null check (trim(recipient_name) <> ''),
  payee_id       text,
  method         text not null,
  bank_name      text,
  account_type   text check (account_type in ('checking','savings')),
  routing_last4  text,
  account_last4  text,
  zelle_hint     text,
  notes          text,
  status         text not null default 'pending' check (status in ('pending','approved','rejected','withdrawn')),
  decided_by     text,
  decided_at     timestamptz,
  decision_note  text,
  payout_id      text,
  created_at     timestamptz not null default now(),
  primary key (org_id, id),
  check (full_balance or amount is not null),
  foreign key (org_id, campaign_id) references public.campaigns (org_id, id) on update cascade,
  foreign key (org_id, manager_id) references public.managers (org_id, id) on update cascade,
  foreign key (org_id, payee_id) references public.payees (org_id, id) on update cascade,
  foreign key (org_id, payout_id) references public.expenses (org_id, id)
);
create index payout_requests_org_campaign_idx on public.payout_requests (org_id, campaign_id);
create index payout_requests_org_manager_idx on public.payout_requests (org_id, manager_id);
create index payout_requests_org_payee_idx on public.payout_requests (org_id, payee_id);
create index payout_requests_org_payout_idx on public.payout_requests (org_id, payout_id);
create index payout_requests_org_pending_idx on public.payout_requests (org_id, created_at) where status = 'pending';
alter table public.expenses add constraint expenses_request_fkey foreign key (org_id, request_id) references public.payout_requests (org_id, id);
alter table public.payee_notes add constraint payee_notes_request_fkey foreign key (org_id, request_id) references public.payout_requests (org_id, id);
create index payee_notes_org_request_idx on public.payee_notes (org_id, request_id);

create table public.payout_request_secrets (
  org_id     uuid not null references public.organizations(id),
  request_id text not null,
  routing    bytea,
  account    bytea,
  zelle      bytea,
  primary key (org_id, request_id),
  foreign key (org_id, request_id) references public.payout_requests (org_id, id) on delete cascade
);

create or replace function public.request_payout(
  p_campaign text, p_amount numeric, p_full_balance boolean, p_recipient text, p_method text,
  p_payee text default null, p_bank_name text default null, p_account_type text default null,
  p_routing text default null, p_account text default null, p_zelle text default null, p_notes text default null
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  v_key text;
  v_routing text := regexp_replace(coalesce(p_routing, ''), '\D', '', 'g');
  v_account text := regexp_replace(coalesce(p_account, ''), '\s', '', 'g');
  v_method text;
  v_manager text;
  v_id text;
begin
  if not public.can_request_payout(p_campaign) then
    raise exception 'Only the primary fundraiser, or someone given payout rights, can request a payout from this campaign';
  end if;
  if not coalesce(p_full_balance, false) and coalesce(p_amount, 0) <= 0 then raise exception 'Enter an amount, or choose the full balance'; end if;
  if nullif(trim(p_recipient), '') is null then raise exception 'Who is the payout going to?'; end if;
  select m.name into v_method from public.payout_methods m where m.org_id = v_org and m.active and lower(m.name) = lower(trim(p_method));
  if v_method is null then raise exception 'Choose a payout method'; end if;
  if p_payee is not null and not exists (select 1 from public.payees p where p.org_id = v_org and p.id = p_payee and p.merged_into is null) then
    raise exception 'Payee not found';
  end if;
  if v_method = 'ACH' then
    if nullif(trim(p_bank_name), '') is null or p_account_type is null then raise exception 'ACH needs the bank name and account type'; end if;
    if length(v_routing) <> 9 then raise exception 'A routing number has 9 digits'; end if;
    if length(v_account) < 4 then raise exception 'Enter the account number'; end if;
  elsif v_method = 'Zelle' then
    if nullif(trim(p_zelle), '') is null then raise exception 'Zelle needs the recipient''s phone number or email'; end if;
  end if;
  v_key := public.payout_key();
  if v_key is null then raise exception 'Payout details can''t be stored safely right now. Tell the office'; end if;
  select c.manager_id into v_manager from public.campaigns c where c.org_id = v_org and c.id = p_campaign;
  if not coalesce(v_manager = any(public.my_manager_ids()), false) then v_manager := (public.my_manager_ids())[1]; end if;

  insert into public.payout_requests (org_id, campaign_id, manager_id, amount, full_balance, recipient_name, payee_id, method,
                                      bank_name, account_type, routing_last4, account_last4, zelle_hint, notes)
  values (v_org, p_campaign, v_manager, case when p_full_balance then null else round(p_amount, 2) end, coalesce(p_full_balance, false),
          trim(p_recipient), p_payee, v_method,
          case when v_method = 'ACH' then trim(p_bank_name) end, case when v_method = 'ACH' then p_account_type end,
          case when v_method = 'ACH' then right(v_routing, 4) end, case when v_method = 'ACH' then right(v_account, 4) end,
          case when v_method = 'Zelle' then left(trim(p_zelle), 2) || '…' end, nullif(trim(p_notes), ''))
  returning id into v_id;
  if v_method in ('ACH','Zelle') then
    insert into public.payout_request_secrets (org_id, request_id, routing, account, zelle)
    values (v_org, v_id,
            case when v_method = 'ACH' then extensions.pgp_sym_encrypt(v_routing, v_key) end,
            case when v_method = 'ACH' then extensions.pgp_sym_encrypt(v_account, v_key) end,
            case when v_method = 'Zelle' then extensions.pgp_sym_encrypt(trim(p_zelle), v_key) end);
  end if;
  return v_id;
end $$;

-- Reading the full numbers is logged.
create or replace function public.payout_request_details(p_request text)
returns table (routing text, account text, zelle text)
language plpgsql security definer set search_path = '' as $$
declare v_key text;
begin
  perform public.require_admin();
  v_key := public.payout_key();
  perform public.write_activity(public.current_org_id(), 'view_payout_details', 'payout_requests', p_request, null, null);
  return query
  select extensions.pgp_sym_decrypt(s.routing, v_key), extensions.pgp_sym_decrypt(s.account, v_key), extensions.pgp_sym_decrypt(s.zelle, v_key)
  from public.payout_request_secrets s where s.org_id = public.current_org_id() and s.request_id = p_request;
end $$;

-- The first admin to act wins; a second gets told who already did.
create or replace function public.lock_pending_request(p_request text) returns public.payout_requests
language plpgsql security definer set search_path = '' as $$
declare r public.payout_requests;
begin
  select * into r from public.payout_requests where org_id = public.current_org_id() and id = p_request for update;
  if r.id is null then raise exception 'Payout request not found'; end if;
  if r.status = 'withdrawn' then raise exception 'The fundraiser withdrew this request'; end if;
  if r.status <> 'pending' then raise exception 'This was already handled by %', coalesce(r.decided_by, 'another admin'); end if;
  return r;
end $$;

create or replace function public.approve_payout_request(
  p_request text, p_payee text, p_method text, p_amount numeric default null, p_account text default null,
  p_scheduled_for date default null, p_reference text default null, p_memo text default null, p_check_number text default null
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  r public.payout_requests;
  v_payee text := p_payee;
  v_amount numeric := p_amount;
  v_id text;
begin
  perform public.require_admin();
  r := public.lock_pending_request(p_request);
  v_payee := coalesce(v_payee, r.payee_id);
  if v_payee is null then
    insert into public.payees (org_id, name, preferred_method) values (v_org, r.recipient_name, r.method) returning id into v_payee;
  end if;
  if v_amount is null then
    v_amount := coalesce(r.amount, (select s.balance from public.campaign_summary s where s.org_id = v_org and s.id = r.campaign_id));
  end if;
  if coalesce(v_amount, 0) <= 0 then raise exception 'Enter the amount to pay'; end if;
  insert into public.expenses (org_id, campaign_id, payee_id, amount, method, account_id, scheduled_for, reference, memo,
                               check_number, request_id, description)
  values (v_org, r.campaign_id, v_payee, round(v_amount, 2), coalesce(p_method, r.method), p_account, p_scheduled_for,
          nullif(trim(p_reference), ''), nullif(trim(p_memo), ''), nullif(trim(p_check_number), ''), r.id, 'Payout request')
  returning id into v_id;
  update public.payout_requests
  set status = 'approved', decided_by = public.current_email(), decided_at = now(), payout_id = v_id, payee_id = v_payee
  where org_id = v_org and id = r.id;
  return v_id;
end $$;

create or replace function public.reject_payout_request(p_request text, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.payout_requests;
begin
  perform public.require_admin();
  r := public.lock_pending_request(p_request);
  update public.payout_requests
  set status = 'rejected', decided_by = public.current_email(), decided_at = now(), decision_note = nullif(trim(p_note), '')
  where org_id = r.org_id and id = r.id;
  if nullif(trim(p_note), '') is not null and r.payee_id is not null then
    insert into public.payee_notes (org_id, payee_id, request_id, note) values (r.org_id, r.payee_id, r.id, trim(p_note));
  end if;
end $$;

create or replace function public.withdraw_payout_request(p_request text) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.payout_requests;
begin
  select * into r from public.payout_requests where org_id = public.current_org_id() and id = p_request for update;
  if r.id is null or not (public.is_admin() or public.can_request_payout(r.campaign_id) or r.requested_by = public.current_email()) then
    raise exception 'Payout request not found';
  end if;
  if r.status <> 'pending' then raise exception 'Only a request that''s still waiting can be withdrawn'; end if;
  update public.payout_requests set status = 'withdrawn', decided_by = public.current_email(), decided_at = now()
  where org_id = r.org_id and id = r.id;
end $$;

-- Search across the whole organization's payees, so nobody makes a duplicate. Names only.
create or replace function public.lookup_payees(p_q text)
returns table (id text, name text)
language plpgsql stable security definer set search_path = '' as $$
declare v_q text := lower(trim(coalesce(p_q, '')));
begin
  if not (public.is_admin() or coalesce(public.my_org_role() = 'manager', false)) then raise exception 'Not allowed'; end if;
  if length(v_q) < 2 then return; end if;
  return query
  select p.id, p.name from public.payees p
  where p.org_id = public.current_org_id() and p.merged_into is null
    and (lower(p.name) like '%' || v_q || '%' or lower(coalesce(p.email, '')) like '%' || v_q || '%'
         or regexp_replace(coalesce(p.phone, ''), '\D', '', 'g') like '%' || nullif(regexp_replace(v_q, '\D', '', 'g'), '') || '%'
         or lower(p.id) = v_q)
  order by lower(p.name) limit 20;
end $$;

-- Permanent. Payouts, requests and notes move to the survivor; a Do Not Pay flag on either carries over.
create or replace function public.merge_payees(p_keep text, p_absorb text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  k public.payees;
  a public.payees;
  v_flag text;
begin
  perform public.require_admin();
  if p_keep = p_absorb then raise exception 'Choose two different payees'; end if;
  select * into k from public.payees where org_id = v_org and id = p_keep and merged_into is null for update;
  select * into a from public.payees where org_id = v_org and id = p_absorb and merged_into is null for update;
  if k.id is null or a.id is null then raise exception 'Payee not found'; end if;
  update public.expenses set payee_id = k.id where org_id = v_org and payee_id = a.id;
  update public.payout_requests set payee_id = k.id where org_id = v_org and payee_id = a.id;
  update public.payee_notes set payee_id = k.id where org_id = v_org and payee_id = a.id;
  select coalesce(f.reason, 'No reason given') into v_flag from public.payee_flags f where f.org_id = v_org and f.payee_id = a.id;
  if found then
    insert into public.payee_flags (org_id, payee_id, reason)
    values (v_org, k.id, 'Carried over from ' || a.name || ' (' || a.id || '): ' || v_flag)
    on conflict (org_id, payee_id) do nothing;
    delete from public.payee_flags where org_id = v_org and payee_id = a.id;
  end if;
  update public.payees
  set address = coalesce(address, a.address), phone = coalesce(phone, a.phone), email = coalesce(email, a.email),
      preferred_method = coalesce(preferred_method, a.preferred_method),
      notes = nullif(concat_ws(E'\n', notes, a.notes), '')
  where org_id = v_org and id = k.id;
  update public.payees set merged_into = k.id where org_id = v_org and id = a.id;
  insert into public.payee_merges (org_id, kept_id, absorbed_id, absorbed_name) values (v_org, k.id, a.id, a.name);
end $$;

-- Totals follow the caller's access, so a fundraiser's figures are from their own campaigns.
create view public.payee_summary with (security_invoker = true) as
select p.id, p.org_id, p.name, p.address, p.phone, p.email, p.preferred_method, p.notes, p.created_at,
       count(e.id) filter (where e.processed_at is not null)                         as payout_count,
       coalesce(sum(e.amount) filter (where e.processed_at is not null), 0)          as total_paid,
       max(e.created_at) filter (where e.processed_at is not null)                   as last_payout_at,
       coalesce(array_agg(distinct e.campaign_id) filter (where e.campaign_id is not null), '{}') as campaigns,
       coalesce(array_agg(distinct e.method) filter (where e.method is not null), '{}')           as methods,
       exists (select 1 from public.payee_flags f where f.org_id = p.org_id and f.payee_id = p.id) as do_not_pay
from public.payees p
left join public.expenses e on e.org_id = p.org_id and e.payee_id = p.id and e.deleted_at is null
where p.merged_into is null
group by p.org_id, p.id;

-- ---------------------------------------------------------------------------
-- Balances now count payouts through campaign_expense_totals()
-- ---------------------------------------------------------------------------
create or replace view public.campaign_summary with (security_invoker = true) as
with recursive walk as (
  select c.org_id, c.id, c.parent_campaign_id as up
  from public.campaigns c where c.balance_mode = 'shared' and c.deleted_at is null
  union all
  select w.org_id, w.id, p.parent_campaign_id
  from walk w join public.campaigns p on p.org_id = w.org_id and p.id = w.up
  where p.balance_mode = 'shared'
), pool as (
  select w.org_id, w.id, w.up as pool_id
  from walk w
  where not exists (select 1 from public.campaigns p where p.org_id = w.org_id and p.id = w.up and p.balance_mode = 'shared')
), d as (
  select org_id, campaign_id,
         sum(case when status <> 'completed' then 0
                  when type = 'Payment' then amount
                  else coalesce(funded, 0) end)                as donations_raised,
         sum(case when status in ('completed','collect','refunded','returned') then coalesce(fee, 0) else 0 end) as fees,
         sum(case when status in ('completed','collect') then coalesce(batch_pending, 0) else 0 end) as pending_balance,
         count(*) filter (where status in ('completed','collect','refunded','returned')) as donation_count,
         max(created_at) filter (where status <> 'failed')     as last_donation_at,
         sum(case when status = 'post_dated' then amount else 0 end) as post_dated_amount,
         sum(case when status = 'pending' then amount else 0 end) as awaiting_approval
  from public.donations where deleted_at is null group by org_id, campaign_id
), e as (
  select * from public.campaign_expense_totals()
), t as (
  select * from public.campaign_transfer_totals()
), vf as (
  select org_id, voucher_id, sum(amount) as funded from public.donations
  where voucher_id is not null and deleted_at is null and status in ('completed','collect') group by org_id, voucher_id
), v as (
  select v.org_id, v.campaign_id, sum(greatest(v.face_value - coalesce(vf.funded, 0), 0)) as awaiting_funds
  from public.vouchers v left join vf on vf.org_id = v.org_id and vf.voucher_id = v.id
  where v.deleted_at is null and v.cancelled_at is null group by v.org_id, v.campaign_id
), pr as (
  select org_id, pledge_id, sum(amount) as received from public.pledge_payments group by org_id, pledge_id
), pl as (
  select p.org_id, p.campaign_id, sum(greatest(p.amount - coalesce(pr.received, 0), 0)) as pledged_open
  from public.pledges p left join pr on pr.org_id = p.org_id and pr.pledge_id = p.id
  where p.deleted_at is null and p.cancelled_at is null group by p.org_id, p.campaign_id
), ip as (
  select org_id, installment_id, sum(amount) as paid from public.pledge_payments where installment_id is not null group by org_id, installment_id
), sch as (
  select p.org_id, p.campaign_id,
         sum(greatest(i.amount - coalesce(ip.paid, 0), 0)) filter (where i.due_date <= current_date + 30) as next_30,
         sum(greatest(i.amount - coalesce(ip.paid, 0), 0)) as next_90
  from public.pledge_installments i
  join public.pledges p on p.org_id = i.org_id and p.id = i.pledge_id
  left join ip on ip.org_id = i.org_id and ip.installment_id = i.id
  where not i.skipped and not i.cancelled and p.deleted_at is null and p.cancelled_at is null
    and i.due_date between current_date and current_date + 90
  group by p.org_id, p.campaign_id
), own as (
  select c.*,
         m.full_name                                                  as manager_name,
         coalesce(d.donations_raised, 0) + coalesce(t.amount_in, 0)   as raised,
         coalesce(d.fees, 0)                                          as fees,
         case when coalesce(d.donations_raised, 0) + coalesce(t.amount_in, 0) = 0 then 0
              else coalesce(d.fees, 0) / (coalesce(d.donations_raised, 0) + coalesce(t.amount_in, 0)) end as fee_percent,
         coalesce(e.expenses, 0) + coalesce(t.amount_out, 0)          as expenses,
         coalesce(d.donations_raised, 0) + coalesce(t.amount_in, 0)
           - coalesce(d.fees, 0) - coalesce(e.expenses, 0) - coalesce(t.amount_out, 0) as own_balance,
         coalesce(d.pending_balance, 0)                               as pending_balance,
         coalesce(d.donation_count, 0)                                as donation_count,
         d.last_donation_at,
         coalesce(d.post_dated_amount, 0)                             as post_dated_amount,
         coalesce(d.awaiting_approval, 0)                             as awaiting_approval,
         coalesce(v.awaiting_funds, 0)                                as awaiting_funds,
         coalesce(pl.pledged_open, 0)                                 as pledged_open,
         coalesce(sch.next_30, 0)                                     as pledge_scheduled_30,
         coalesce(sch.next_90, 0)                                     as pledge_scheduled_90,
         pool.pool_id
  from public.campaigns c
  left join public.managers m on m.org_id = c.org_id and m.id = c.manager_id and m.deleted_at is null
  left join d    on d.org_id   = c.org_id and d.campaign_id   = c.id
  left join e    on e.org_id   = c.org_id and e.campaign_id   = c.id
  left join t    on t.org_id   = c.org_id and t.campaign_id   = c.id
  left join v    on v.org_id   = c.org_id and v.campaign_id   = c.id
  left join pl   on pl.org_id  = c.org_id and pl.campaign_id  = c.id
  left join sch  on sch.org_id = c.org_id and sch.campaign_id = c.id
  left join pool on pool.org_id = c.org_id and pool.id = c.id
  where c.deleted_at is null
), rollup as (
  select org_id, coalesce(pool_id, id) as id,
         sum(raised) as raised, sum(fees) as fees, sum(expenses) as expenses, sum(own_balance) as balance, sum(donation_count) as donations
  from own group by org_id, coalesce(pool_id, id)
), kids as (
  select org_id, parent_campaign_id as id, count(*) as sub_count from own where parent_campaign_id is not null group by org_id, parent_campaign_id
)
select o.*,
       case when o.pool_id is not null then 0 else r.balance end as balance,
       coalesce(r.raised, o.raised)      as combined_raised,
       coalesce(r.fees, o.fees)          as combined_fees,
       coalesce(r.expenses, o.expenses)  as combined_expenses,
       coalesce(r.donations, o.donation_count) as combined_donations,
       coalesce(k.sub_count, 0)          as sub_count
from own o
left join rollup r on r.org_id = o.org_id and r.id = o.id
left join kids k on k.org_id = o.org_id and k.id = o.id;

-- ---------------------------------------------------------------------------
-- Payout requests and scheduled payouts that have come due reach the Task Sheet
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
         d.reversal_date::timestamptz, 'Check' || coalesce(' #' || d.check_number, '') || coalesce(' from ' || nullif(d.name, ''), '') || coalesce(' · ' || d.reversal_reason, '')
  from public.donations d
  left join public.campaigns c on c.org_id = d.org_id and c.id = d.campaign_id
  left join public.managers m on m.org_id = c.org_id and m.id = c.manager_id
  where d.status = 'returned' and d.reversal_date is not null and d.deleted_at is null
  union all
  select d.org_id, 'post_dated_due:' || d.id, 'post_dated_due', d.id, d.campaign_id, m.full_name, d.amount,
         d.check_date::timestamptz, 'Check' || coalesce(' #' || d.check_number, '') || coalesce(' from ' || nullif(d.name, ''), '') || ' is ready to deposit'
  from public.donations d
  left join public.campaigns c on c.org_id = d.org_id and c.id = d.campaign_id
  left join public.managers m on m.org_id = c.org_id and m.id = c.manager_id
  where d.post_dated and d.check_date <= current_date and d.status = 'completed' and d.deleted_at is null
  union all
  select v.org_id, 'voucher_overdue:' || v.id || ':' || coalesce(v.expected_date::text, ''), 'voucher_overdue', v.id, v.campaign_id, m.full_name, v.remaining,
         coalesce(v.expected_date, v.date_received + 30)::timestamptz,
         v.id || coalesce(' · issuer #' || v.issuer_number, '') || ' · ' || replace(v.issuer, 'Voucher — ', '') || coalesce(' · ' || v.donor_name, '') || ' · face ' || v.face_value
  from public.voucher_list v
  left join public.campaigns c on c.org_id = v.org_id and c.id = v.campaign_id
  left join public.managers m on m.org_id = c.org_id and m.id = c.manager_id
  where v.overdue
  union all
  select p.org_id, 'pledge_overdue:' || p.id || ':' || coalesce(p.next_due_date, p.expected_date)::text, 'pledge_overdue', p.id, p.campaign_id, m.full_name, p.balance,
         coalesce(p.next_due_date, p.expected_date)::timestamptz, p.reference || coalesce(' · ' || p.donor_name, '')
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
         e.scheduled_for::timestamptz,
         coalesce(e.method, 'Payout') || coalesce(' to ' || nullif(e.payee, ''), '') || ' was set for ' || to_char(e.scheduled_for, 'FMMonth FMDD, YYYY')
  from public.expenses e
  left join public.campaigns c on c.org_id = e.org_id and c.id = e.campaign_id
  left join public.managers m on m.org_id = c.org_id and m.id = c.manager_id
  where e.processed_at is null and e.scheduled_for <= public.org_today() and e.deleted_at is null
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
alter table public.payout_methods         enable row level security;
alter table public.payees                 enable row level security;
alter table public.payee_flags            enable row level security;
alter table public.payee_notes            enable row level security;
alter table public.payee_merges           enable row level security;
alter table public.payout_requests        enable row level security;
alter table public.payout_request_secrets enable row level security;
revoke all on public.payout_methods, public.payees, public.payee_flags, public.payee_notes, public.payee_merges,
              public.payout_requests, public.payout_request_secrets from anon;
revoke insert, update, delete on public.payout_methods, public.payee_notes, public.payee_merges,
              public.payout_requests, public.payout_request_secrets from authenticated;
revoke delete on public.payees from authenticated;
revoke all on public.payout_request_secrets from authenticated;

do $$
declare t text;
begin
  foreach t in array array['payout_methods','payees','payee_flags','payee_notes','payee_merges','payout_requests','payout_request_secrets'] loop
    execute format('create policy org_wall on public.%I as restrictive for all to authenticated
                    using (org_id = (select public.current_org_id()))
                    with check (org_id = (select public.current_org_id()))', t);
  end loop;
  foreach t in array array['payout_methods','payees','payee_flags','payee_notes','payee_merges','payout_requests'] loop
    execute format('create trigger log_row_change after insert or update or delete on public.%I
                    for each row execute function public.log_row_change()', t);
  end loop;
end $$;

create policy active_read on public.payout_methods for select to authenticated using ((select public.is_active_user()));

create policy admin_read   on public.payees for select to authenticated using ((select public.is_admin()));
create policy admin_insert on public.payees for insert to authenticated with check ((select public.is_admin()));
create policy admin_update on public.payees for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
-- A fundraiser sees the payees on payouts and requests they can see.
create policy manager_read on public.payees for select to authenticated
  using (id in (select e.payee_id from public.expenses e where e.payee_id is not null)
         or id in (select r.payee_id from public.payout_requests r where r.payee_id is not null));
create trigger touch_updated_at before update on public.payees for each row execute function public.touch_updated_at();

create policy admin_all on public.payee_flags for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy admin_read on public.payee_notes for select to authenticated using ((select public.is_admin()));
create policy admin_read on public.payee_merges for select to authenticated using ((select public.is_admin()));

create policy admin_read on public.payout_requests for select to authenticated using ((select public.is_admin()));
create policy manager_read on public.payout_requests for select to authenticated
  using (requested_by = (select public.current_email())
         or (campaign_id = any((select public.my_campaign_ids())::text[]) and public.can_see_payout_detail(campaign_id)));

revoke execute on function public.seed_payout_methods(uuid) from public, anon, authenticated;
revoke execute on function public.org_payout_methods() from public, anon, authenticated;
revoke execute on function public.payout_rules() from public, anon, authenticated;
revoke execute on function public.payout_key() from public, anon, authenticated;
revoke execute on function public.lock_pending_request(text) from public, anon, authenticated;
revoke execute on function public.campaign_expense_totals() from public, anon;
grant execute on function public.campaign_expense_totals() to authenticated;
do $$
declare f text;
begin
  foreach f in array array[
    'save_payout_method(text, text, text, text, boolean)',
    'process_scheduled_payout(text, text)',
    'can_see_payout_detail(text)',
    'can_request_payout(text)',
    'campaign_payouts(text)',
    'request_payout(text, numeric, boolean, text, text, text, text, text, text, text, text, text)',
    'payout_request_details(text)',
    'approve_payout_request(text, text, text, numeric, text, date, text, text, text)',
    'reject_payout_request(text, text)',
    'withdraw_payout_request(text)',
    'lookup_payees(text)',
    'merge_payees(text, text)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

revoke all on public.payee_summary from anon;
grant select on public.payee_summary to authenticated;

do $$
declare v_moved int;
begin
  select count(*) into v_moved
  from _balances_before b
  full join public.campaign_summary c on c.org_id = b.org_id and c.id = b.id
  where b.raised is distinct from c.raised or b.fees is distinct from c.fees
     or b.expenses is distinct from c.expenses or b.balance is distinct from c.balance
     or b.pending_balance is distinct from c.pending_balance;
  if v_moved > 0 then
    raise exception 'Payout migration changed the balance of % campaign(s)', v_moved;
  end if;
end $$;

drop table _balances_before;
