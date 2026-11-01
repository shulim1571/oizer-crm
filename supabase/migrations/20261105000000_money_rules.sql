-- Phase 4, part 1: payment methods and fees, fundraiser entry with approval, batch entry, split
-- donations, refunds, returned and post-dated checks, duplicate flags. The migration fails at the
-- end if any campaign's numbers changed.

create temp table _balances_before as
  select org_id, id, raised, fees, expenses, balance, pending_balance from public.campaign_summary;

-- ---------------------------------------------------------------------------
-- Payment methods and their fees. Fees start at nothing: admins set the real rates.
-- ---------------------------------------------------------------------------
create table public.payment_methods (
  id              text not null default public.short_id(),
  org_id          uuid not null default public.current_org_id() references public.organizations(id),
  name            text not null,
  category        text not null default 'Manual',
  fee_type        text not null default 'none' check (fee_type in ('none','flat','percent','percent_flat')),
  fee_percent     numeric(6,3) not null default 0 check (fee_percent >= 0),
  fee_flat        numeric(12,2) not null default 0 check (fee_flat >= 0),
  receipt_allowed boolean not null default true,
  is_custom       boolean not null default true,
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  primary key (org_id, id)
);
create unique index payment_methods_name on public.payment_methods (org_id, lower(name));

create table public.campaign_fee_overrides (
  id          text not null default public.short_id(),
  org_id      uuid not null default public.current_org_id() references public.organizations(id),
  campaign_id text not null,
  method_id   text not null,
  fee_type    text not null default 'none' check (fee_type in ('none','flat','percent','percent_flat')),
  fee_percent numeric(6,3) not null default 0 check (fee_percent >= 0),
  fee_flat    numeric(12,2) not null default 0 check (fee_flat >= 0),
  created_at  timestamptz not null default now(),
  primary key (org_id, id),
  unique (org_id, campaign_id, method_id),
  foreign key (org_id, campaign_id) references public.campaigns (org_id, id) on update cascade,
  foreign key (org_id, method_id) references public.payment_methods (org_id, id) on delete cascade
);

create or replace function public.seed_payment_methods(p_org uuid) returns void
language sql security definer set search_path = '' as $$
  insert into public.payment_methods (org_id, name, category, receipt_allowed, is_custom)
  select p_org, m.name, m.category, m.receipt, false
  from (values
    ('Credit Card', 'Gateway', true), ('Debit Card', 'Gateway', true),
    ('Check', 'Manual', true), ('Cash', 'Manual', true), ('Zelle', 'Manual', true),
    ('Wire', 'Manual', true), ('ACH', 'Manual', true), ('Account Transfer', 'Manual', true), ('Zeffy', 'Manual', true),
    ('OJC', 'DAF', false), ('Donors Fund', 'DAF', false), ('Pledger', 'DAF', false), ('Matbia', 'DAF', false),
    ('Fidelity DAF', 'DAF', false), ('PayPal Giving Fund', 'DAF', false),
    ('OJC Online', 'DAF', false), ('Donors Fund Online', 'DAF', false), ('Pledger Online', 'DAF', false), ('Matbia Online', 'DAF', false)
  ) as m(name, category, receipt)
  on conflict do nothing
$$;

select public.seed_payment_methods(id) from public.organizations;

create or replace function public.seed_org_settings(p_org uuid) returns void
language sql security definer set search_path = '' as $$
  insert into public.settings (org_id, key, value, description, updated_by) values
    (p_org, 'timezone', '"America/New_York"', 'Time zone for dates, reports and digests', 'system'),
    (p_org, 'duplicate_window_minutes', '10', 'Same donor, amount and campaign within this window is flagged as a possible duplicate', 'system'),
    (p_org, 'inactive_campaign_days', '90', 'Active campaigns with no activity for this long are flagged', 'system'),
    (p_org, 'stale_check_days', '90', 'Outstanding checks older than this are flagged', 'system'),
    (p_org, 'max_phones_per_fundraiser', '3', 'Registered phone numbers allowed per fundraiser', 'system'),
    (p_org, 'auto_receipt', 'false', 'Send receipts automatically unless a campaign overrides it', 'system'),
    (p_org, 'machine_digest_time', '"22:00"', 'When the daily Donary machine summary goes out', 'system')
  on conflict do nothing;
  insert into public.sources (org_id, id, name) values (p_org, 'Manual', 'Manual')
  on conflict do nothing;
  select public.seed_payment_methods(p_org);
$$;

create or replace function public.calculate_fee(p_org uuid, p_campaign text, p_method text, p_amount numeric) returns numeric
language sql stable security definer set search_path = '' as $$
  select round(case r.fee_type
                 when 'flat' then r.fee_flat
                 when 'percent' then p_amount * r.fee_percent / 100
                 when 'percent_flat' then p_amount * r.fee_percent / 100 + r.fee_flat
                 else 0 end, 2)
  from (
    select coalesce(o.fee_type, m.fee_type) fee_type, coalesce(o.fee_percent, m.fee_percent) fee_percent, coalesce(o.fee_flat, m.fee_flat) fee_flat
    from public.payment_methods m
    left join public.campaign_fee_overrides o on o.org_id = m.org_id and o.method_id = m.id and o.campaign_id = p_campaign
    where m.org_id = p_org and lower(m.name) = lower(p_method)
  ) r
$$;

-- ---------------------------------------------------------------------------
-- New donation fields and statuses
-- ---------------------------------------------------------------------------
create table public.batch_entries (
  id           text not null,
  org_id       uuid not null default public.current_org_id() references public.organizations(id),
  campaign_id  text,
  client_key   text not null,
  submitted_by text not null default public.current_email(),
  source_label text not null,
  row_count    int not null default 0,
  total        numeric(14,2) not null default 0,
  created_at   timestamptz not null default now(),
  primary key (org_id, id),
  unique (org_id, client_key),
  foreign key (org_id, campaign_id) references public.campaigns (org_id, id) on update cascade
);

alter table public.donations
  add column check_number text,
  add column post_dated boolean not null default false,
  add column check_date date,
  add column anonymous boolean not null default false,
  add column possible_duplicate boolean not null default false,
  add column duplicate_reviewed_by text,
  add column reversal_date date,
  add column reversal_reason text,
  add column reversal_method text,
  add column reversal_notes text,
  add column replaces_donation_id text,
  add column split_group_id text,
  add column batch_entry_id text,
  add column reviewed_by text,
  add column reviewed_at timestamptz,
  add column review_note text,
  add column delete_reason text;

alter table public.donations drop constraint donations_status_check;
alter table public.donations add constraint donations_status_check
  check (status in ('completed','pending','post_dated','collect','voided','refunded','returned','failed','rejected'));
alter table public.donations add constraint donations_batch_entry_fkey foreign key (org_id, batch_entry_id)
  references public.batch_entries (org_id, id);
create index donations_org_batch_idx on public.donations (org_id, batch_entry_id);
create index donations_org_split_idx on public.donations (org_id, split_group_id);
create index donations_post_dated_idx on public.donations (check_date) where status = 'post_dated';

-- ---------------------------------------------------------------------------
-- What happens when a donation is saved
-- ---------------------------------------------------------------------------
create or replace function public.donation_defaults() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_window int;
begin
  if tg_op = 'UPDATE' then
    if (new.amount is distinct from old.amount or new.fee is distinct from old.fee)
       and new.net_donation is not distinct from old.net_donation then
      new.net_donation := new.amount - coalesce(new.fee, 0);
    end if;
    return new;
  end if;

  -- Anything a fundraiser enters waits for an admin.
  if auth.uid() is not null and not public.is_admin() then
    new.status := 'pending';
  elsif new.post_dated and new.check_date > current_date and new.status = 'completed' then
    new.status := 'post_dated';
  end if;

  if new.fee is null and new.payment_method is not null then
    new.fee := public.calculate_fee(new.org_id, new.campaign_id, new.payment_method, new.amount);
  end if;
  if new.net_donation is null then
    new.net_donation := new.amount - coalesce(new.fee, 0);
  end if;
  if new.type = 'Batch' and new.is_batch is null then
    new.is_batch := true;
  end if;

  -- Same donor, amount and campaign moments apart. Flags both; never blocks.
  if new.donor_id is not null and new.campaign_id is not null then
    select coalesce((s.value #>> '{}')::int, 10) into v_window
    from public.settings s where s.org_id = new.org_id and s.key = 'duplicate_window_minutes';
    update public.donations d set possible_duplicate = true
    where d.org_id = new.org_id and d.donor_id = new.donor_id and d.campaign_id = new.campaign_id and d.amount = new.amount
      and d.deleted_at is null and d.status not in ('voided','failed','rejected')
      and d.created_at between new.created_at - make_interval(mins => coalesce(v_window, 10)) and new.created_at + make_interval(mins => coalesce(v_window, 10));
    if found then new.possible_duplicate := true; end if;
  end if;
  return new;
end $$;

-- Now also fires when a gift becomes real, such as on approval.
create or replace function public.campaign_activity_rules() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_status text;
  v_row jsonb := to_jsonb(new);
  v_reactivates boolean := tg_table_name = 'pledges'
    or (tg_table_name = 'donations' and v_row ->> 'status' in ('completed','collect'));
begin
  if new.campaign_id is null then return new; end if;
  if tg_op = 'UPDATE' and new.campaign_id is not distinct from old.campaign_id
     and not (tg_table_name = 'donations' and v_reactivates and to_jsonb(old) ->> 'status' not in ('completed','collect')) then
    return new;
  end if;
  -- A correction to a gift that already counted doesn't bring back or block anything.
  if tg_op = 'UPDATE' and tg_table_name = 'donations' and to_jsonb(old) ->> 'status' in ('voided','refunded','returned') then
    return new;
  end if;
  select c.status into v_status from public.campaigns c where c.org_id = new.org_id and c.id = new.campaign_id;
  if v_status = 'closed' then
    raise exception 'Campaign % is closed and can''t accept new activity', new.campaign_id;
  end if;
  if v_status = 'archived' and v_reactivates then
    update public.campaigns set status = 'active' where org_id = new.org_id and id = new.campaign_id;
  end if;
  return new;
end $$;

drop trigger campaign_activity_rules on public.donations;
create trigger campaign_activity_rules before insert or update of campaign_id, status on public.donations
  for each row execute function public.campaign_activity_rules();

-- ---------------------------------------------------------------------------
-- Actions on a donation. All admin only, and all logged by the row trigger.
-- ---------------------------------------------------------------------------
create or replace function public.require_admin() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Only admins can do this'; end if;
end $$;

-- A refund did happen, so the fee stays spent and only the net comes off the balance.
create or replace function public.refund_donation(p_id text, p_date date default null, p_method text default null, p_notes text default null) returns void
language plpgsql set search_path = '' as $$
begin
  perform public.require_admin();
  update public.donations
  set status = 'refunded', reversal_date = coalesce(p_date, current_date), reversal_method = p_method, reversal_notes = p_notes
  where id = p_id and org_id = public.current_org_id() and status in ('completed','collect');
  if not found then raise exception 'Only a completed transaction can be refunded'; end if;
end $$;

create or replace function public.return_check(p_id text, p_date date, p_reason text, p_notes text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  d public.donations;
begin
  perform public.require_admin();
  update public.donations
  set status = 'returned', reversal_date = coalesce(p_date, current_date), reversal_reason = p_reason, reversal_notes = p_notes
  where id = p_id and org_id = v_org and status in ('completed','collect') and lower(coalesce(payment_method, '')) like '%check%'
  returning * into d;
  if d.id is null then raise exception 'Only a completed check can be marked returned'; end if;
  if d.campaign_id is not null then
    insert into public.tasks (org_id, campaign_id, donor_id, title, description, status)
    values (v_org, d.campaign_id, d.donor_id,
            'Collect replacement for returned check: ' || coalesce(nullif(d.name, ''), nullif(d.donor_label, ''), 'donor') || ' $' || trim(to_char(d.amount, 'FM999,999,990.00')),
            'Bank reason: ' || coalesce(p_reason, 'not given'), 'Pending');
  end if;
end $$;

create or replace function public.delete_donation(p_id text, p_reason text) returns void
language plpgsql set search_path = '' as $$
begin
  perform public.require_admin();
  if nullif(trim(p_reason), '') is null then raise exception 'A reason is required to delete a transaction'; end if;
  update public.donations set delete_reason = p_reason where id = p_id and org_id = public.current_org_id();
  if not found then raise exception 'Transaction not found'; end if;
  delete from public.donations where id = p_id and org_id = public.current_org_id();
end $$;

-- First admin to act wins, so the same entry can't be handled twice.
create or replace function public.review_donation(p_id text, p_approve boolean, p_note text default null) returns void
language plpgsql set search_path = '' as $$
declare v_by text;
begin
  perform public.require_admin();
  if not p_approve and nullif(trim(p_note), '') is null then raise exception 'A reason is required to reject an entry'; end if;
  update public.donations
  set status = case when p_approve then 'completed' else 'rejected' end,
      reviewed_by = public.current_email(), reviewed_at = now(), review_note = p_note
  where id = p_id and org_id = public.current_org_id() and status = 'pending';
  if not found then
    select reviewed_by into v_by from public.donations where id = p_id and org_id = public.current_org_id();
    raise exception 'This was already handled by %', coalesce(v_by, 'another admin');
  end if;
end $$;

create or replace function public.mark_duplicate_reviewed(p_id text) returns void
language plpgsql set search_path = '' as $$
begin
  perform public.require_admin();
  update public.donations set possible_duplicate = false, duplicate_reviewed_by = public.current_email()
  where id = p_id and org_id = public.current_org_id();
  if not found then raise exception 'Transaction not found'; end if;
end $$;

-- Splits one gift across campaigns. The fee is shared in proportion, and rounding pennies go to the
-- largest part. The original record becomes the first part.
create or replace function public.split_donation(p_id text, p_legs jsonb, p_reason text default null) returns text
language plpgsql set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  d public.donations;
  v_group text;
  v_total numeric := 0;
  v_fee_total numeric;
  v_fees numeric := 0;
  v_max numeric := -1;
  v_max_i int := 0;
  v_count int := jsonb_array_length(p_legs);
  v_amount numeric;
  v_fee numeric;
  i int;
begin
  perform public.require_admin();
  select * into d from public.donations where id = p_id and org_id = v_org and deleted_at is null for update;
  if d.id is null then raise exception 'Transaction not found'; end if;
  if d.status not in ('completed','collect') then raise exception 'Only a completed transaction can be split'; end if;
  if d.split_group_id is not null then raise exception 'This transaction is already split'; end if;
  if v_count < 2 then raise exception 'A split needs at least two campaigns'; end if;

  for i in 0 .. v_count - 1 loop
    v_amount := (p_legs -> i ->> 'amount')::numeric;
    if v_amount is null or v_amount <= 0 then raise exception 'Each part needs an amount above zero'; end if;
    if nullif(p_legs -> i ->> 'campaign_id', '') is null then raise exception 'Each part needs a campaign'; end if;
    v_total := v_total + v_amount;
    if v_amount > v_max then v_max := v_amount; v_max_i := i; end if;
  end loop;
  if v_total <> d.amount then
    raise exception 'The parts add up to % but the transaction is %', v_total, d.amount;
  end if;

  v_group := public.short_id();
  v_fee_total := coalesce(d.fee, 0);
  for i in 0 .. v_count - 1 loop
    if i <> v_max_i then
      v_fees := v_fees + round(v_fee_total * (p_legs -> i ->> 'amount')::numeric / v_total, 2);
    end if;
  end loop;

  for i in 0 .. v_count - 1 loop
    v_amount := (p_legs -> i ->> 'amount')::numeric;
    v_fee := case when i = v_max_i then v_fee_total - v_fees else round(v_fee_total * v_amount / v_total, 2) end;
    if i = 0 then
      update public.donations
      set campaign_id = p_legs -> 0 ->> 'campaign_id', amount = v_amount, fee = v_fee, net_donation = v_amount - v_fee,
          split_group_id = v_group, notes = case when p_reason is null then notes else concat_ws(E'\n', notes, 'Split: ' || p_reason) end
      where id = d.id and org_id = v_org;
    else
      insert into public.donations (org_id, campaign_id, donor_id, donor_label, collector_id, collector_label, type, status, amount, fee, net_donation,
                                    source, payment_method, name, phone, email, notes, account_id, split_group_id, created_at, anonymous, check_number)
      values (v_org, p_legs -> i ->> 'campaign_id', d.donor_id, d.donor_label, d.collector_id, d.collector_label, d.type, d.status, v_amount, v_fee, v_amount - v_fee,
              d.source, d.payment_method, d.name, d.phone, d.email, d.notes, d.account_id, v_group, d.created_at, d.anonymous, d.check_number);
    end if;
  end loop;
  return v_group;
end $$;

-- ---------------------------------------------------------------------------
-- Batch entry: all rows together or none. Security definer because a fundraiser with the override
-- may add donors here, which they can't do directly; the checks below take its place.
-- ---------------------------------------------------------------------------
create table public.org_counters (
  org_id uuid not null references public.organizations(id),
  prefix text not null,
  year   int not null,
  last_n int not null default 0,
  primary key (org_id, prefix, year)
);
alter table public.org_counters enable row level security;
revoke all on public.org_counters from anon, authenticated;

create or replace function public.next_reference(p_org uuid, p_prefix text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_year int := extract(year from now());
  v_n int;
begin
  insert into public.org_counters (org_id, prefix, year, last_n) values (p_org, p_prefix, v_year, 1)
  on conflict (org_id, prefix, year) do update set last_n = public.org_counters.last_n + 1
  returning last_n into v_n;
  return p_prefix || '-' || v_year || '-' || lpad(v_n::text, 5, '0');
end $$;

create or replace function public.submit_batch(p_campaign text, p_client_key text, p_rows jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  v_admin boolean := public.is_admin();
  v_batch text;
  v_total numeric := 0;
  r jsonb;
  v_amount numeric;
  v_donor text;
  v_first text;
  v_last text;
  v_name text;
begin
  if not v_admin and not (p_campaign = any(public.my_campaign_ids()) and public.has_override('enter_manual_payments', p_campaign)) then
    raise exception 'You don''t have permission to enter payments on this campaign';
  end if;
  if not exists (select 1 from public.campaigns c where c.org_id = v_org and c.id = p_campaign and c.deleted_at is null) then
    raise exception 'Campaign not found';
  end if;
  if jsonb_array_length(p_rows) = 0 then raise exception 'The batch has no rows'; end if;

  -- A double click or a retry sends the same key and changes nothing.
  select id into v_batch from public.batch_entries where org_id = v_org and client_key = p_client_key;
  if v_batch is not null then return v_batch; end if;

  v_batch := public.next_reference(v_org, 'BCH');
  insert into public.batch_entries (id, org_id, campaign_id, client_key, source_label, row_count)
  values (v_batch, v_org, p_campaign, p_client_key,
          case when v_admin then 'Batch Entry — Admin' else 'Batch Entry — Fundraiser (Pending)' end, jsonb_array_length(p_rows));

  for r in select * from jsonb_array_elements(p_rows) loop
    v_amount := (r ->> 'amount')::numeric;
    if v_amount is null or v_amount <= 0 then raise exception 'Every row needs an amount above zero'; end if;
    if nullif(r ->> 'payment_method', '') is null then raise exception 'Every row needs a payment method'; end if;
    v_donor := nullif(r ->> 'donor_id', '');
    v_name := nullif(trim(r ->> 'name'), '');

    if v_donor is not null and not exists (select 1 from public.donors d where d.org_id = v_org and d.id = v_donor and d.deleted_at is null) then
      raise exception 'Donor not found';
    end if;

    if v_donor is null and v_name is not null and (r ->> 'create_donor')::boolean is true then
      v_first := split_part(v_name, ' ', 1);
      v_last := nullif(trim(substr(v_name, length(v_first) + 1)), '');
      insert into public.donors (org_id, first_name, last_name, phone, email)
      values (v_org, v_first, v_last, nullif(r ->> 'phone', ''), nullif(r ->> 'email', ''))
      returning id into v_donor;
    end if;

    insert into public.donations (org_id, campaign_id, donor_id, name, phone, amount, payment_method, check_number, notes,
                                  source, batch_entry_id, type, status)
    values (v_org, p_campaign, v_donor, v_name, nullif(r ->> 'phone', ''), v_amount, r ->> 'payment_method',
            nullif(r ->> 'check_number', ''), nullif(r ->> 'notes', ''), 'Manual', v_batch, 'Payment', 'completed');
    v_total := v_total + v_amount;
  end loop;

  update public.batch_entries set total = v_total where org_id = v_org and id = v_batch;
  return v_batch;
end $$;

-- ---------------------------------------------------------------------------
-- Post-dated checks reach the balance on their date, by the daily job.
-- ---------------------------------------------------------------------------
create or replace function public.clear_post_dated() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  v_count int := 0;
  v_status text;
begin
  for r in select org_id, id, campaign_id from public.donations
           where status = 'post_dated' and check_date <= current_date and deleted_at is null for update loop
    select status into v_status from public.campaigns where org_id = r.org_id and id = r.campaign_id;
    if v_status = 'closed' then
      -- A closed campaign takes nothing new: an admin assigns this elsewhere.
      update public.donations set campaign_id = null, status = 'completed',
        notes = concat_ws(E'\n', notes, 'Campaign ' || r.campaign_id || ' was closed when this check cleared.')
      where org_id = r.org_id and id = r.id;
    else
      update public.donations set status = 'completed' where org_id = r.org_id and id = r.id;
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

create or replace function public.run_job(p_job text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_id bigint;
begin
  insert into public.job_runs (job) values (p_job) returning id into v_id;
  begin
    case p_job
      when 'heartbeat' then null;
      when 'post_dated' then perform public.clear_post_dated();
      else raise exception 'Unknown job %', p_job;
    end case;
    update public.job_runs set finished_at = now(), ok = true where id = v_id;
  exception when others then
    update public.job_runs set finished_at = now(), ok = false, error = sqlerrm where id = v_id;
  end;
end $$;

select cron.schedule('post_dated', '0 10 * * *', $$select public.run_job('post_dated')$$);

-- ---------------------------------------------------------------------------
-- Summaries and the transaction list
-- ---------------------------------------------------------------------------
create or replace view public.campaign_summary with (security_invoker = true) as
with d as (
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
  select org_id, campaign_id, sum(amount) as expenses from public.expenses where deleted_at is null group by org_id, campaign_id
), tin as (
  select org_id, to_campaign_id as campaign_id, sum(amount) as amt from public.transfers where deleted_at is null group by org_id, to_campaign_id
), tout as (
  select org_id, from_campaign_id as campaign_id, sum(amount) as amt from public.transfers where deleted_at is null group by org_id, from_campaign_id
)
select c.*,
       m.full_name                                                  as manager_name,
       coalesce(d.donations_raised, 0) + coalesce(tin.amt, 0)       as raised,
       coalesce(d.fees, 0)                                          as fees,
       case when coalesce(d.donations_raised, 0) + coalesce(tin.amt, 0) = 0 then 0
            else coalesce(d.fees, 0) / (coalesce(d.donations_raised, 0) + coalesce(tin.amt, 0)) end as fee_percent,
       coalesce(e.expenses, 0) + coalesce(tout.amt, 0)              as expenses,
       coalesce(d.donations_raised, 0) + coalesce(tin.amt, 0)
         - coalesce(d.fees, 0) - coalesce(e.expenses, 0) - coalesce(tout.amt, 0) as balance,
       coalesce(d.pending_balance, 0)                               as pending_balance,
       coalesce(d.donation_count, 0)                                as donation_count,
       d.last_donation_at,
       coalesce(d.post_dated_amount, 0)                             as post_dated_amount,
       coalesce(d.awaiting_approval, 0)                             as awaiting_approval
from public.campaigns c
left join public.managers m on m.org_id = c.org_id and m.id = c.manager_id and m.deleted_at is null
left join d    on d.org_id    = c.org_id and d.campaign_id    = c.id
left join e    on e.org_id    = c.org_id and e.campaign_id    = c.id
left join tin  on tin.org_id  = c.org_id and tin.campaign_id  = c.id
left join tout on tout.org_id = c.org_id and tout.campaign_id = c.id
where c.deleted_at is null;

drop view public.transaction_list;
create view public.transaction_list with (security_invoker = true) as
select d.*,
       c.internal_name as campaign_internal,
       c.external_name as campaign_external,
       coalesce(dn.display_name, nullif(trim(d.donor_label), ''), d.name) as donor_name,
       coalesce(co.full_name, d.collector_label) as collector_name,
       s.name as source_name,
       a.name as account_name
from public.donations d
left join public.campaigns  c  on c.org_id  = d.org_id and c.id  = d.campaign_id
left join public.donors     dn on dn.org_id = d.org_id and dn.id = d.donor_id
left join public.collectors co on co.org_id = d.org_id and co.id = d.collector_id
left join public.sources    s  on s.org_id  = d.org_id and s.id  = d.source
left join public.accounts   a  on a.org_id  = d.org_id and a.id  = d.account_id
where d.deleted_at is null;
revoke all on public.transaction_list from anon;
grant select on public.transaction_list to authenticated;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
alter table public.payment_methods        enable row level security;
alter table public.campaign_fee_overrides enable row level security;
alter table public.batch_entries          enable row level security;
revoke all on public.payment_methods, public.campaign_fee_overrides, public.batch_entries from anon;
revoke insert, update, delete on public.batch_entries from authenticated;

do $$
declare t text;
begin
  foreach t in array array['payment_methods','campaign_fee_overrides','batch_entries'] loop
    execute format('create policy org_wall on public.%I as restrictive for all to authenticated
                    using (org_id = (select public.current_org_id()))
                    with check (org_id = (select public.current_org_id()))', t);
  end loop;
end $$;

create policy active_read on public.payment_methods for select to authenticated using ((select public.is_active_user()));
create policy fee_insert on public.payment_methods for insert to authenticated with check ((select public.has_super_permission('configure_fees')));
create policy fee_update on public.payment_methods for update to authenticated
  using ((select public.has_super_permission('configure_fees'))) with check ((select public.has_super_permission('configure_fees')));
create policy admin_read on public.campaign_fee_overrides for select to authenticated using ((select public.is_admin()));
create policy fee_insert on public.campaign_fee_overrides for insert to authenticated with check ((select public.has_super_permission('configure_fees')));
create policy fee_update on public.campaign_fee_overrides for update to authenticated
  using ((select public.has_super_permission('configure_fees'))) with check ((select public.has_super_permission('configure_fees')));
create policy fee_delete on public.campaign_fee_overrides for delete to authenticated using ((select public.has_super_permission('configure_fees')));
create policy admin_read on public.batch_entries for select to authenticated using ((select public.is_admin()));
create policy own_read on public.batch_entries for select to authenticated using (submitted_by = (select public.current_email()));

-- A fundraiser with the override can enter a payment; the trigger holds it for approval.
create policy manager_insert on public.donations for insert to authenticated
  with check (campaign_id = any((select public.my_campaign_ids())::text[])
              and public.has_override('enter_manual_payments', campaign_id));

create trigger log_row_change after insert or update or delete on public.payment_methods
  for each row execute function public.log_row_change();
create trigger log_row_change after insert or update or delete on public.campaign_fee_overrides
  for each row execute function public.log_row_change();
create trigger log_row_change after insert on public.batch_entries
  for each row execute function public.log_row_change();

-- ---------------------------------------------------------------------------
-- Function access
-- ---------------------------------------------------------------------------
revoke execute on function public.seed_payment_methods(uuid) from public, anon, authenticated;
revoke execute on function public.next_reference(uuid, text) from public, anon, authenticated;
revoke execute on function public.clear_post_dated() from public, anon, authenticated;
revoke execute on function public.require_admin() from public, anon;
revoke execute on function public.calculate_fee(uuid, text, text, numeric) from public, anon;
revoke execute on function public.refund_donation(text, date, text, text) from public, anon;
revoke execute on function public.return_check(text, date, text, text) from public, anon;
revoke execute on function public.delete_donation(text, text) from public, anon;
revoke execute on function public.review_donation(text, boolean, text) from public, anon;
revoke execute on function public.mark_duplicate_reviewed(text) from public, anon;
revoke execute on function public.split_donation(text, jsonb, text) from public, anon;
revoke execute on function public.submit_batch(text, text, jsonb) from public, anon;
grant execute on function public.require_admin() to authenticated;
grant execute on function public.calculate_fee(uuid, text, text, numeric) to authenticated;
grant execute on function public.refund_donation(text, date, text, text) to authenticated;
grant execute on function public.return_check(text, date, text, text) to authenticated;
grant execute on function public.delete_donation(text, text) to authenticated;
grant execute on function public.review_donation(text, boolean, text) to authenticated;
grant execute on function public.mark_duplicate_reviewed(text) to authenticated;
grant execute on function public.split_donation(text, jsonb, text) to authenticated;
grant execute on function public.submit_batch(text, text, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Stop here if any campaign's numbers moved.
-- ---------------------------------------------------------------------------
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
    raise exception 'Money rules migration changed the balance of % campaign(s)', v_moved;
  end if;
end $$;

drop table _balances_before;
