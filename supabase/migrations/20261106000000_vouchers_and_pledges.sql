-- Phase 4, part 2: vouchers (log once, fund in stages) and pledges (one-time and recurring, matched
-- to payments as they arrive). Neither touches the balance until real money does. Existing Batch rows
-- stay as they are. The migration fails at the end if any campaign's numbers changed.

create temp table _balances_before as
  select org_id, id, raised, fees, expenses, balance, pending_balance from public.campaign_summary;

-- ---------------------------------------------------------------------------
-- Voucher issuers are payment methods, so their default fees live in Methods & Fees.
-- ---------------------------------------------------------------------------
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
    ('OJC Online', 'DAF', false), ('Donors Fund Online', 'DAF', false), ('Pledger Online', 'DAF', false), ('Matbia Online', 'DAF', false),
    ('Voucher — OJC Fund', 'Voucher', true), ('Voucher — Donors Fund', 'Voucher', true),
    ('Voucher — Pledger', 'Voucher', true), ('Voucher — Matbia', 'Voucher', true)
  ) as m(name, category, receipt)
  on conflict do nothing
$$;

select public.seed_payment_methods(id) from public.organizations;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.vouchers (
  id             text not null,
  org_id         uuid not null default public.current_org_id() references public.organizations(id),
  campaign_id    text,
  donor_id       text,
  name           text,
  issuer         text not null,
  issuer_number  text,
  submission     text not null default 'online' check (submission in ('online','mailed')),
  account_number text,
  face_value     numeric(14,2) not null check (face_value > 0),
  fee_type       text not null check (fee_type in ('none','flat','percent','percent_flat')),
  fee_percent    numeric(6,3) not null default 0 check (fee_percent >= 0),
  fee_flat       numeric(12,2) not null default 0 check (fee_flat >= 0),
  date_received  date not null default current_date,
  expected_date  date,
  notes          text,
  overage_flag   boolean not null default false,
  cancelled_at   timestamptz,
  cancel_reason  text,
  created_by     text default public.current_email(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,
  deleted_by     text,
  primary key (org_id, id),
  foreign key (org_id, campaign_id) references public.campaigns (org_id, id) on update cascade,
  foreign key (org_id, donor_id) references public.donors (org_id, id)
);
create index vouchers_org_campaign_idx on public.vouchers (org_id, campaign_id);
create index vouchers_org_donor_idx on public.vouchers (org_id, donor_id);

alter table public.pledges
  add column reference text,
  add column date_pledged date not null default current_date,
  add column expected_date date,
  add column is_recurring boolean not null default false,
  add column installment_amount numeric(12,2) check (installment_amount > 0),
  add column frequency text check (frequency in ('weekly','monthly','quarterly','annually')),
  add column start_date date,
  add column installment_count int check (installment_count > 0),
  add column cancelled_at timestamptz,
  add column cancel_reason text;

-- Existing pledges get a reference and their real date, without counting as edits.
alter table public.pledges disable trigger user;
do $$
declare r record;
begin
  for r in select org_id, id, created_at from public.pledges order by created_at, id loop
    update public.pledges set reference = public.next_reference(r.org_id, 'PLG'), date_pledged = r.created_at::date
    where org_id = r.org_id and id = r.id;
  end loop;
end $$;
alter table public.pledges enable trigger user;
alter table public.pledges alter column reference set not null;
create unique index pledges_org_reference on public.pledges (org_id, reference);

create table public.pledge_installments (
  id        text not null default public.short_id(),
  org_id    uuid not null references public.organizations(id),
  pledge_id text not null,
  seq       int not null,
  due_date  date not null,
  amount    numeric(12,2) not null check (amount > 0),
  skipped   boolean not null default false,
  skip_note text,
  cancelled boolean not null default false,
  primary key (org_id, id),
  unique (org_id, pledge_id, seq),
  foreign key (org_id, pledge_id) references public.pledges (org_id, id) on delete cascade
);

alter table public.donations
  add column voucher_id text,
  add column pledge_id text,
  add column bank_reference text;
alter table public.donations add constraint donations_voucher_fkey foreign key (org_id, voucher_id)
  references public.vouchers (org_id, id);
alter table public.donations add constraint donations_pledge_fkey foreign key (org_id, pledge_id)
  references public.pledges (org_id, id);
create index donations_org_voucher_idx on public.donations (org_id, voucher_id);
create index donations_org_pledge_idx on public.donations (org_id, pledge_id);

create table public.pledge_payments (
  id             text not null default public.short_id(),
  org_id         uuid not null references public.organizations(id),
  pledge_id      text not null,
  installment_id text,
  donation_id    text not null,
  amount         numeric(14,2) not null check (amount > 0),
  matched_by     text not null check (matched_by in ('auto','manual','pay_button')),
  created_by     text default public.current_email(),
  created_at     timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, pledge_id) references public.pledges (org_id, id) on delete cascade,
  foreign key (org_id, installment_id) references public.pledge_installments (org_id, id),
  foreign key (org_id, donation_id) references public.donations (org_id, id)
);
create index pledge_payments_org_pledge_idx on public.pledge_payments (org_id, pledge_id);
create index pledge_payments_org_donation_idx on public.pledge_payments (org_id, donation_id);
create index pledge_payments_org_installment_idx on public.pledge_payments (org_id, installment_id);

-- ---------------------------------------------------------------------------
-- Vouchers: what's set once when logged, and what can't change after money arrives
-- ---------------------------------------------------------------------------
-- What's actually arrived. A refunded or voided funding entry reopens that part of the voucher.
create or replace function public.voucher_funded(p_org uuid, p_voucher text) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(d.amount), 0) from public.donations d
  where d.org_id = p_org and d.voucher_id = p_voucher and d.deleted_at is null and d.status in ('completed','collect')
$$;

create or replace function public.voucher_defaults() returns trigger
language plpgsql security definer set search_path = '' as $$
declare m public.payment_methods;
begin
  if tg_op = 'INSERT' then
    new.id := public.next_reference(new.org_id, 'VCH');
    if new.fee_type is null then
      select * into m from public.payment_methods p where p.org_id = new.org_id and lower(p.name) = lower(new.issuer);
      new.fee_type := coalesce(m.fee_type, 'none');
      new.fee_percent := coalesce(m.fee_percent, 0);
      new.fee_flat := coalesce(m.fee_flat, 0);
    end if;
  end if;
  new.fee_percent := coalesce(new.fee_percent, 0);
  new.fee_flat := coalesce(new.fee_flat, 0);
  if new.submission = 'online' then new.account_number := null; end if;

  if tg_op = 'UPDATE' then
    declare v_funded numeric := public.voucher_funded(new.org_id, new.id);
    begin
      if v_funded > 0 then
        if new.campaign_id is distinct from old.campaign_id then
          raise exception 'This voucher has funding on its campaign and can''t be moved';
        end if;
        if (new.fee_type, new.fee_percent, new.fee_flat) is distinct from (old.fee_type, old.fee_percent, old.fee_flat) then
          raise exception 'The fee is set once and can''t change after funds have arrived';
        end if;
        if new.deleted_at is not null and old.deleted_at is null then
          raise exception 'This voucher has funding. Delete its funding entries first';
        end if;
      end if;
      if new.face_value < v_funded then
        raise exception 'Face value can''t be less than the % already funded', v_funded;
      end if;
    end;
  end if;
  return new;
end $$;

create trigger voucher_defaults before insert or update on public.vouchers
  for each row execute function public.voucher_defaults();

-- Each funding entry is an ordinary donation, so the balance, reports and receipts all see it. Going
-- over the face value is refused but leaves a flag, which is why this returns instead of raising.
create or replace function public.add_voucher_funding(
  p_voucher text, p_amount numeric, p_date date default null, p_bank_reference text default null, p_fee numeric default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  v public.vouchers;
  v_funded numeric;
  v_fee numeric;
  v_status text;
  v_campaign text;
  v_id text;
begin
  perform public.require_admin();
  select * into v from public.vouchers where org_id = v_org and id = p_voucher and deleted_at is null for update;
  if v.id is null then raise exception 'Voucher not found'; end if;
  if v.cancelled_at is not null then raise exception 'This voucher was cancelled'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Enter an amount above zero'; end if;

  v_funded := public.voucher_funded(v_org, v.id);
  if v_funded + p_amount > v.face_value then
    update public.vouchers set overage_flag = true where org_id = v_org and id = v.id;
    return jsonb_build_object('ok', false, 'remaining', v.face_value - v_funded);
  end if;

  v_fee := coalesce(p_fee, round(case v.fee_type
    when 'flat' then v.fee_flat
    when 'percent' then p_amount * v.fee_percent / 100
    when 'percent_flat' then p_amount * v.fee_percent / 100 + v.fee_flat
    else 0 end, 2));

  -- A closed campaign takes nothing new: an admin assigns this elsewhere. Archived ones reactivate.
  v_campaign := v.campaign_id;
  select status into v_status from public.campaigns where org_id = v_org and id = v.campaign_id;
  if v_status = 'closed' then v_campaign := null; end if;

  insert into public.donations (org_id, campaign_id, donor_id, name, amount, fee, net_donation, payment_method, source, type, status,
                                voucher_id, batch_id, bank_reference, created_at, notes)
  values (v_org, v_campaign, v.donor_id, v.name, p_amount, v_fee, p_amount - v_fee, v.issuer, 'Manual', 'Payment', 'completed',
          v.id, v.issuer_number, p_bank_reference,
          case when p_date is null or p_date = current_date then now() else p_date::timestamptz end,
          case when v_status = 'closed' then 'Campaign ' || v.campaign_id || ' was closed when this voucher funded.' end)
  returning id into v_id;

  update public.vouchers set overage_flag = false where org_id = v_org and id = v.id and overage_flag;
  return jsonb_build_object('ok', true, 'donation_id', v_id, 'fee', v_fee, 'net', p_amount - v_fee);
end $$;

create or replace function public.cancel_voucher(p_voucher text, p_reason text) returns void
language plpgsql set search_path = '' as $$
begin
  perform public.require_admin();
  if nullif(trim(p_reason), '') is null then raise exception 'A reason is required to cancel a voucher'; end if;
  update public.vouchers set cancelled_at = now(), cancel_reason = p_reason, overage_flag = false
  where org_id = public.current_org_id() and id = p_voucher and cancelled_at is null;
  if not found then raise exception 'Voucher not found, or already cancelled'; end if;
end $$;

create or replace function public.clear_voucher_overage(p_voucher text) returns void
language plpgsql set search_path = '' as $$
begin
  perform public.require_admin();
  update public.vouchers set overage_flag = false where org_id = public.current_org_id() and id = p_voucher;
end $$;

-- ---------------------------------------------------------------------------
-- Pledges: schedules
-- ---------------------------------------------------------------------------
create or replace function public.pledge_due_date(p_start date, p_frequency text, p_n int) returns date
language sql immutable set search_path = '' as $$
  -- Always counted from the start, so the 31st comes back after a short month.
  select (case p_frequency
            when 'weekly' then p_start + make_interval(days => 7 * p_n)
            when 'monthly' then p_start + make_interval(months => p_n)
            when 'quarterly' then p_start + make_interval(months => 3 * p_n)
            when 'annually' then p_start + make_interval(years => p_n)
          end)::date
$$;

-- The commitment is whatever is still scheduled plus what was already paid on the rest.
create or replace function public.refresh_pledge_amount(p_org uuid, p_pledge text) returns void
language sql security definer set search_path = '' as $$
  update public.pledges p
  set amount = coalesce((select sum(i.amount) from public.pledge_installments i
                         where i.org_id = p_org and i.pledge_id = p_pledge and not i.skipped and not i.cancelled), 0)
             + coalesce((select sum(pp.amount) from public.pledge_payments pp
                         join public.pledge_installments i on i.org_id = pp.org_id and i.id = pp.installment_id
                         where pp.org_id = p_org and pp.pledge_id = p_pledge and (i.skipped or i.cancelled)), 0)
  where p.org_id = p_org and p.id = p_pledge
$$;

create or replace function public.add_installments(p_org uuid, p_pledge text, p_start date, p_frequency text, p_amount numeric, p_count int) returns void
language plpgsql security definer set search_path = '' as $$
declare v_seq int;
begin
  select coalesce(max(seq), 0) into v_seq from public.pledge_installments where org_id = p_org and pledge_id = p_pledge;
  insert into public.pledge_installments (org_id, pledge_id, seq, due_date, amount)
  select p_org, p_pledge, v_seq + n + 1, public.pledge_due_date(p_start, p_frequency, n), p_amount
  from generate_series(0, p_count - 1) n;
end $$;

create or replace function public.pledge_defaults() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.reference := public.next_reference(new.org_id, 'PLG');
  if new.is_recurring then
    if new.installment_amount is null or new.frequency is null then
      raise exception 'A recurring pledge needs an installment amount and a frequency';
    end if;
    new.start_date := coalesce(new.start_date, new.date_pledged);
    -- Open-ended pledges carry a rolling year of installments.
    new.amount := new.installment_amount * coalesce(new.installment_count, 12);
  end if;
  return new;
end $$;

create or replace function public.pledge_schedule() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.is_recurring then
    perform public.add_installments(new.org_id, new.id, new.start_date, new.frequency, new.installment_amount, coalesce(new.installment_count, 12));
  end if;
  return null;
end $$;

create trigger pledge_defaults before insert on public.pledges
  for each row execute function public.pledge_defaults();
create trigger pledge_schedule after insert on public.pledges
  for each row execute function public.pledge_schedule();

create or replace function public.extend_open_pledges() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  v_ahead int;
  v_n int;
  v_due date;
  v_count int := 0;
begin
  for r in select p.org_id, p.id, p.start_date, p.frequency, p.installment_amount
           from public.pledges p
           where p.is_recurring and p.installment_count is null and p.cancelled_at is null and p.deleted_at is null loop
    select count(*) filter (where i.due_date > current_date), count(*) into v_ahead, v_n
    from public.pledge_installments i
    where i.org_id = r.org_id and i.pledge_id = r.id and not i.cancelled and i.due_date >= r.start_date;
    if v_ahead >= 12 then continue; end if;
    -- Counted from the start each time, so dates don't drift after a short month.
    while v_ahead < 12 loop
      v_due := public.pledge_due_date(r.start_date, r.frequency, v_n);
      perform public.add_installments(r.org_id, r.id, v_due, r.frequency, r.installment_amount, 1);
      v_n := v_n + 1;
      if v_due > current_date then v_ahead := v_ahead + 1; end if;
    end loop;
    perform public.refresh_pledge_amount(r.org_id, r.id);
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
      when 'pledge_schedules' then perform public.extend_open_pledges();
      else raise exception 'Unknown job %', p_job;
    end case;
    update public.job_runs set finished_at = now(), ok = true where id = v_id;
  exception when others then
    update public.job_runs set finished_at = now(), ok = false, error = sqlerrm where id = v_id;
  end;
end $$;

select cron.schedule('pledge_schedules', '0 9 * * *', $$select public.run_job('pledge_schedules')$$);

-- ---------------------------------------------------------------------------
-- Pledges: matching payments
-- ---------------------------------------------------------------------------
create or replace function public.pledge_balance(p_org uuid, p_pledge text) returns numeric
language sql stable security definer set search_path = '' as $$
  select greatest(p.amount - coalesce((select sum(pp.amount) from public.pledge_payments pp
                                       where pp.org_id = p.org_id and pp.pledge_id = p.id), 0), 0)
  from public.pledges p where p.org_id = p_org and p.id = p_pledge
$$;

-- Fills the chosen installment first if there is one, then the earliest outstanding. Returns what it used.
create or replace function public.apply_to_pledge(
  p_org uuid, p_pledge text, p_donation text, p_amount numeric, p_by text, p_first text default null
) returns numeric
language plpgsql security definer set search_path = '' as $$
declare
  v_recurring boolean;
  v_left numeric;
  v_part numeric;
  r record;
begin
  select is_recurring into v_recurring from public.pledges where org_id = p_org and id = p_pledge for update;
  v_left := least(p_amount, public.pledge_balance(p_org, p_pledge));
  if v_left <= 0 then return 0; end if;

  if not v_recurring then
    insert into public.pledge_payments (org_id, pledge_id, donation_id, amount, matched_by)
    values (p_org, p_pledge, p_donation, v_left, p_by);
    return v_left;
  end if;

  v_part := v_left;
  for r in select i.id, i.amount - coalesce((select sum(pp.amount) from public.pledge_payments pp
                                             where pp.org_id = i.org_id and pp.installment_id = i.id), 0) as remaining
           from public.pledge_installments i
           where i.org_id = p_org and i.pledge_id = p_pledge and not i.skipped and not i.cancelled
           order by (i.id = p_first) desc nulls last, i.seq loop
    continue when r.remaining <= 0;
    exit when v_left <= 0;
    insert into public.pledge_payments (org_id, pledge_id, installment_id, donation_id, amount, matched_by)
    values (p_org, p_pledge, r.id, p_donation, least(v_left, r.remaining), p_by);
    v_left := v_left - least(v_left, r.remaining);
  end loop;
  return v_part - v_left;
end $$;

-- Any payment, from any channel, the moment it becomes real. Same donor and campaign: an exact match
-- on what's next due wins, otherwise the oldest pledge it fits inside. A payment larger than what's
-- owed is left alone for an admin to match by hand. A refund later doesn't reopen anything.
create or replace function public.match_donation_to_pledge() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_pledge text;
begin
  if new.status <> 'completed' or new.type <> 'Payment' or new.deleted_at is not null or new.amount <= 0 then return null; end if;
  if tg_op = 'UPDATE' and old.status = 'completed' then return null; end if;
  if exists (select 1 from public.pledge_payments pp where pp.org_id = new.org_id and pp.donation_id = new.id) then return null; end if;

  if new.pledge_id is not null then
    perform public.apply_to_pledge(new.org_id, new.pledge_id, new.id, new.amount, 'pay_button');
    return null;
  end if;
  if new.donor_id is null or new.campaign_id is null then return null; end if;

  select p.id into v_pledge
  from public.pledges p
  cross join lateral (select public.pledge_balance(p.org_id, p.id) as balance) b
  left join lateral (
    select i.amount - coalesce((select sum(pp.amount) from public.pledge_payments pp
                                where pp.org_id = i.org_id and pp.installment_id = i.id), 0) as remaining
    from public.pledge_installments i
    where i.org_id = p.org_id and i.pledge_id = p.id and not i.skipped and not i.cancelled
      and i.amount > coalesce((select sum(pp.amount) from public.pledge_payments pp
                               where pp.org_id = i.org_id and pp.installment_id = i.id), 0)
    order by i.seq limit 1
  ) nxt on p.is_recurring
  where p.org_id = new.org_id and p.donor_id = new.donor_id and p.campaign_id = new.campaign_id
    and p.cancelled_at is null and p.deleted_at is null and b.balance >= new.amount
  order by (case when p.is_recurring then nxt.remaining else b.balance end = new.amount) desc, p.date_pledged, p.created_at
  limit 1;

  if v_pledge is not null then
    perform public.apply_to_pledge(new.org_id, v_pledge, new.id, new.amount, 'auto');
  end if;
  return null;
end $$;

create trigger match_donation_to_pledge after insert or update of status on public.donations
  for each row execute function public.match_donation_to_pledge();

-- Splitting or shrinking a matched payment would leave the pledge counting money that moved.
create or replace function public.guard_matched_amount() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.amount < coalesce((select sum(pp.amount) from public.pledge_payments pp where pp.org_id = new.org_id and pp.donation_id = new.id), 0) then
    raise exception 'This payment is matched to a pledge. Unmatch it first';
  end if;
  return new;
end $$;

create trigger guard_matched_amount before update of amount on public.donations
  for each row when (new.amount is distinct from old.amount) execute function public.guard_matched_amount();

-- ---------------------------------------------------------------------------
-- Pledges: actions. Everything here is logged by the row triggers.
-- ---------------------------------------------------------------------------
-- Admins, or a fundraiser on the pledge's campaign.
create or replace function public.pledge_for_work(p_pledge text) returns public.pledges
language plpgsql stable security definer set search_path = '' as $$
declare p public.pledges;
begin
  select * into p from public.pledges where org_id = public.current_org_id() and id = p_pledge and deleted_at is null;
  if p.id is null then raise exception 'Pledge not found'; end if;
  if not public.is_admin() and not (p.campaign_id = any(public.my_campaign_ids())) then
    raise exception 'You don''t have access to this pledge';
  end if;
  return p;
end $$;

-- A payment taken from the pledge itself. A fundraiser's waits for approval, and counts then.
create or replace function public.pay_pledge(
  p_pledge text, p_amount numeric, p_method text, p_check_number text default null, p_notes text default null
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  p public.pledges := public.pledge_for_work(p_pledge);
  v_id text;
begin
  if not public.is_admin() and not public.has_override('enter_manual_payments', p.campaign_id) then
    raise exception 'You don''t have permission to enter payments on this campaign';
  end if;
  if p.cancelled_at is not null then raise exception 'This pledge was cancelled'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Enter an amount above zero'; end if;
  if nullif(p_method, '') is null then raise exception 'Choose a payment method'; end if;

  insert into public.donations (org_id, campaign_id, donor_id, donor_label, name, phone, email, amount, payment_method, check_number, notes, source, type, status, pledge_id)
  values (p.org_id, p.campaign_id, p.donor_id, p.donor_label, p.name, p.phone, p.email, p_amount, p_method, nullif(p_check_number, ''), nullif(p_notes, ''), 'Manual', 'Payment', 'completed', p.id)
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.match_pledge_payment(p_pledge text, p_donation text, p_installment text default null) returns numeric
language plpgsql security definer set search_path = '' as $$
declare
  p public.pledges := public.pledge_for_work(p_pledge);
  d public.donations;
  v_free numeric;
  v_used numeric;
begin
  if p.cancelled_at is not null then raise exception 'This pledge was cancelled'; end if;
  select * into d from public.donations where org_id = p.org_id and id = p_donation and deleted_at is null;
  if d.id is null then raise exception 'Transaction not found'; end if;
  if d.campaign_id is distinct from p.campaign_id then raise exception 'That payment is on a different campaign'; end if;
  if d.status <> 'completed' then raise exception 'Only a completed payment can be matched'; end if;
  v_free := d.amount - coalesce((select sum(pp.amount) from public.pledge_payments pp where pp.org_id = d.org_id and pp.donation_id = d.id), 0);
  if v_free <= 0 then raise exception 'That payment is already fully matched'; end if;
  v_used := public.apply_to_pledge(p.org_id, p.id, d.id, v_free, 'manual', p_installment);
  if v_used = 0 then raise exception 'Nothing is left to pay on this pledge'; end if;
  return v_used;
end $$;

create or replace function public.unmatch_pledge_payment(p_pledge text, p_donation text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_admin();
  delete from public.pledge_payments where org_id = public.current_org_id() and pledge_id = p_pledge and donation_id = p_donation;
  if not found then raise exception 'That payment isn''t matched to this pledge'; end if;
  update public.donations set pledge_id = null where org_id = public.current_org_id() and id = p_donation and pledge_id = p_pledge;
end $$;

create or replace function public.add_pledge_note(p_pledge text, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare p public.pledges := public.pledge_for_work(p_pledge);
begin
  if nullif(trim(p_note), '') is null then raise exception 'Write a note first'; end if;
  update public.pledges
  set notes = concat_ws(E'\n', notes, to_char(current_date, 'Mon FMDD') || ' · ' || public.current_email() || ': ' || trim(p_note))
  where org_id = p.org_id and id = p.id;
end $$;

create or replace function public.pledge_to_task(p_pledge text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  p public.pledges := public.pledge_for_work(p_pledge);
  v_who text;
  v_id text;
begin
  select coalesce(d.display_name, nullif(trim(p.donor_label), ''), p.name, 'donor') into v_who
  from (select 1) x left join public.donors d on d.org_id = p.org_id and d.id = p.donor_id;
  insert into public.tasks (org_id, campaign_id, donor_id, title, description, status)
  values (p.org_id, p.campaign_id, p.donor_id,
          'Follow up on pledge ' || p.reference || ': ' || v_who || ' $' || trim(to_char(public.pledge_balance(p.org_id, p.id), 'FM999,999,990.00')),
          p.notes, 'Pending')
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.skip_installment(p_installment text, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  i public.pledge_installments;
begin
  select * into i from public.pledge_installments where org_id = v_org and id = p_installment;
  if i.id is null then raise exception 'Installment not found'; end if;
  perform public.pledge_for_work(i.pledge_id);
  if nullif(trim(p_note), '') is null then raise exception 'A note is required to skip an installment'; end if;
  if exists (select 1 from public.pledge_payments pp where pp.org_id = v_org and pp.installment_id = i.id) then
    raise exception 'This installment already has a payment';
  end if;
  update public.pledge_installments set skipped = true, skip_note = p_note where org_id = v_org and id = i.id;
  perform public.refresh_pledge_amount(v_org, i.pledge_id);
end $$;

create or replace function public.edit_installment(p_installment text, p_due date, p_amount numeric) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  i public.pledge_installments;
begin
  perform public.require_admin();
  select * into i from public.pledge_installments where org_id = v_org and id = p_installment;
  if i.id is null then raise exception 'Installment not found'; end if;
  if p_amount < coalesce((select sum(pp.amount) from public.pledge_payments pp where pp.org_id = v_org and pp.installment_id = i.id), 0) then
    raise exception 'The amount can''t be less than what was already paid on it';
  end if;
  update public.pledge_installments set due_date = coalesce(p_due, due_date), amount = coalesce(p_amount, amount) where org_id = v_org and id = i.id;
  perform public.refresh_pledge_amount(v_org, i.pledge_id);
end $$;

-- New terms from a date on. Anything already paid on stays exactly as it was.
create or replace function public.reschedule_pledge(p_pledge text, p_amount numeric, p_frequency text, p_start date, p_count int) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  p public.pledges;
begin
  perform public.require_admin();
  select * into p from public.pledges where org_id = v_org and id = p_pledge and deleted_at is null for update;
  if p.id is null or not p.is_recurring then raise exception 'Recurring pledge not found'; end if;
  if p.cancelled_at is not null then raise exception 'This pledge was cancelled'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Enter an installment amount above zero'; end if;
  if p_frequency is null or p_start is null then raise exception 'Choose a frequency and a start date'; end if;

  update public.pledge_installments i set cancelled = true
  where i.org_id = v_org and i.pledge_id = p.id and not i.skipped and not i.cancelled
    and not exists (select 1 from public.pledge_payments pp where pp.org_id = i.org_id and pp.installment_id = i.id);
  perform public.add_installments(v_org, p.id, p_start, p_frequency, p_amount, coalesce(p_count, 12));
  update public.pledges set installment_amount = p_amount, frequency = p_frequency, start_date = p_start, installment_count = p_count
  where org_id = v_org and id = p.id;
  perform public.refresh_pledge_amount(v_org, p.id);
end $$;

-- What was paid stays; what's still scheduled is cancelled.
create or replace function public.cancel_pledge(p_pledge text, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  perform public.require_admin();
  if nullif(trim(p_reason), '') is null then raise exception 'A reason is required to cancel a pledge'; end if;
  update public.pledges set cancelled_at = now(), cancel_reason = p_reason
  where org_id = v_org and id = p_pledge and cancelled_at is null and deleted_at is null;
  if not found then raise exception 'Pledge not found, or already cancelled'; end if;
  update public.pledge_installments i set cancelled = true
  where i.org_id = v_org and i.pledge_id = p_pledge and not i.skipped
    and not exists (select 1 from public.pledge_payments pp where pp.org_id = i.org_id and pp.installment_id = i.id);
end $$;

-- ---------------------------------------------------------------------------
-- Lists. Status is worked out when read, so it can't drift from the money or the calendar.
-- ---------------------------------------------------------------------------
create view public.voucher_list with (security_invoker = true) as
select v.*,
       coalesce(f.funded, 0) as total_funded,
       coalesce(f.fees, 0) as total_fees,
       coalesce(f.net, 0) as total_net,
       case when v.cancelled_at is not null then 0 else v.face_value - coalesce(f.funded, 0) end as remaining,
       round(coalesce(f.funded, 0) / v.face_value * 100, 1) as percent_funded,
       case when v.cancelled_at is not null then 'cancelled'
            when v.overage_flag then 'overage_review'
            when coalesce(f.funded, 0) >= v.face_value then 'funded'
            when coalesce(f.funded, 0) > 0 then 'partial'
            else 'pending' end as status,
       v.cancelled_at is null and coalesce(f.funded, 0) < v.face_value
         and (v.expected_date < current_date or (v.expected_date is null and v.date_received <= current_date - 30)) as overdue,
       coalesce(dn.display_name, v.name) as donor_name,
       c.internal_name as campaign_internal,
       c.external_name as campaign_external
from public.vouchers v
left join lateral (
  select sum(d.amount) funded, sum(coalesce(d.fee, 0)) fees, sum(d.net_donation) net
  from public.donations d
  where d.org_id = v.org_id and d.voucher_id = v.id and d.deleted_at is null and d.status in ('completed','collect')
) f on true
left join public.donors dn on dn.org_id = v.org_id and dn.id = v.donor_id
left join public.campaigns c on c.org_id = v.org_id and c.id = v.campaign_id
where v.deleted_at is null;

create view public.installment_list with (security_invoker = true) as
select i.*,
       coalesce(paid.amount, 0) as paid,
       greatest(i.amount - coalesce(paid.amount, 0), 0) as remaining,
       case when i.cancelled then 'cancelled'
            when i.skipped then 'skipped'
            when coalesce(paid.amount, 0) >= i.amount then 'fulfilled'
            when i.due_date < current_date then 'overdue'
            when coalesce(paid.amount, 0) > 0 then 'partial'
            else 'open' end as status
from public.pledge_installments i
left join lateral (
  select sum(pp.amount) amount from public.pledge_payments pp where pp.org_id = i.org_id and pp.installment_id = i.id
) paid on true;

create view public.pledge_list with (security_invoker = true) as
select p.*,
       coalesce(r.received, 0) as received,
       greatest(p.amount - coalesce(r.received, 0), 0) as balance,
       case when p.cancelled_at is not null then 'cancelled'
            when p.amount > 0 and coalesce(r.received, 0) >= p.amount then 'fulfilled'
            when p.is_recurring and s.overdue > 0 then 'overdue'
            when not p.is_recurring and coalesce(r.received, 0) = 0 and p.expected_date < current_date then 'overdue'
            when coalesce(r.received, 0) > 0 then 'partial'
            else 'open' end as status,
       current_date - p.date_pledged as days_outstanding,
       s.next_due_date,
       s.next_due_amount,
       s.installments_paid,
       s.installments_upcoming,
       s.overdue as installments_overdue,
       coalesce(dn.display_name, nullif(trim(p.donor_label), ''), p.name) as donor_name,
       c.internal_name as campaign_internal,
       c.external_name as campaign_external
from public.pledges p
left join lateral (
  select sum(pp.amount) received from public.pledge_payments pp where pp.org_id = p.org_id and pp.pledge_id = p.id
) r on true
left join lateral (
  select count(*) filter (where i.status = 'overdue') overdue,
         count(*) filter (where i.status = 'fulfilled') installments_paid,
         count(*) filter (where i.status in ('open','partial')) installments_upcoming,
         min(i.due_date) filter (where i.status in ('open','partial','overdue')) next_due_date,
         (array_agg(i.remaining order by i.seq) filter (where i.status in ('open','partial','overdue')))[1] next_due_amount
  from public.installment_list i where i.org_id = p.org_id and i.pledge_id = p.id
) s on true
left join public.donors dn on dn.org_id = p.org_id and dn.id = p.donor_id
left join public.campaigns c on c.org_id = p.org_id and c.id = p.campaign_id
where p.deleted_at is null;

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
       coalesce(d.awaiting_approval, 0)                             as awaiting_approval,
       coalesce(v.awaiting_funds, 0)                                as awaiting_funds,
       coalesce(pl.pledged_open, 0)                                 as pledged_open,
       coalesce(sch.next_30, 0)                                     as pledge_scheduled_30,
       coalesce(sch.next_90, 0)                                     as pledge_scheduled_90
from public.campaigns c
left join public.managers m on m.org_id = c.org_id and m.id = c.manager_id and m.deleted_at is null
left join d    on d.org_id    = c.org_id and d.campaign_id    = c.id
left join e    on e.org_id    = c.org_id and e.campaign_id    = c.id
left join tin  on tin.org_id  = c.org_id and tin.campaign_id  = c.id
left join tout on tout.org_id = c.org_id and tout.campaign_id = c.id
left join v    on v.org_id    = c.org_id and v.campaign_id    = c.id
left join pl   on pl.org_id   = c.org_id and pl.campaign_id   = c.id
left join sch  on sch.org_id  = c.org_id and sch.campaign_id  = c.id
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

revoke all on public.transaction_list, public.voucher_list, public.installment_list, public.pledge_list from anon;
grant select on public.transaction_list, public.voucher_list, public.installment_list, public.pledge_list to authenticated;

-- ---------------------------------------------------------------------------
-- Row-level security and shared triggers
-- ---------------------------------------------------------------------------
alter table public.vouchers            enable row level security;
alter table public.pledge_installments enable row level security;
alter table public.pledge_payments     enable row level security;
revoke all on public.vouchers, public.pledge_installments, public.pledge_payments from anon;
-- Schedules and matches only ever change through the functions above.
revoke insert, update, delete on public.pledge_installments, public.pledge_payments from authenticated;

do $$
declare t text;
begin
  foreach t in array array['vouchers','pledge_installments','pledge_payments'] loop
    execute format('create policy org_wall on public.%I as restrictive for all to authenticated
                    using (org_id = (select public.current_org_id()))
                    with check (org_id = (select public.current_org_id()))', t);
  end loop;
end $$;

create policy hide_deleted on public.vouchers as restrictive for select to authenticated using (deleted_at is null);
create policy admin_all on public.vouchers for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy manager_read on public.vouchers for select to authenticated
  using (campaign_id = any((select public.my_campaign_ids())::text[]));

create policy admin_read on public.pledge_installments for select to authenticated using ((select public.is_admin()));
create policy manager_read on public.pledge_installments for select to authenticated
  using (pledge_id in (select p.id from public.pledges p where p.campaign_id = any((select public.my_campaign_ids())::text[])));
create policy admin_read on public.pledge_payments for select to authenticated using ((select public.is_admin()));
create policy manager_read on public.pledge_payments for select to authenticated
  using (pledge_id in (select p.id from public.pledges p where p.campaign_id = any((select public.my_campaign_ids())::text[])));

create policy manager_insert on public.pledges for insert to authenticated
  with check (campaign_id = any((select public.my_campaign_ids())::text[]));

create trigger soft_delete before delete on public.vouchers for each row execute function public.soft_delete();
create trigger guard_deleted_columns before update on public.vouchers for each row execute function public.guard_deleted_columns();
create trigger touch_updated_at before update on public.vouchers for each row execute function public.touch_updated_at();
create trigger campaign_activity_rules before insert or update of campaign_id on public.vouchers
  for each row execute function public.campaign_activity_rules();
create trigger log_row_change after insert or update or delete on public.vouchers
  for each row execute function public.log_row_change();
create trigger log_row_change after insert or update or delete on public.pledge_installments
  for each row execute function public.log_row_change();
create trigger log_row_change after insert or update or delete on public.pledge_payments
  for each row execute function public.log_row_change();

create or replace function public.restore_record(p_table text, p_id text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_count int;
begin
  if not public.is_admin() then
    raise exception 'Only admins can restore records';
  end if;
  if p_table <> all (array['managers','collectors','donors','accounts','sources','campaigns','donations',
                           'expenses','transfers','pledges','tasks','vouchers']) then
    raise exception 'Cannot restore records in %', p_table;
  end if;
  execute format('update public.%I set deleted_at = null, deleted_by = null
                  where org_id = $1 and id = $2 and deleted_at is not null', p_table)
    using public.current_org_id(), p_id;
  get diagnostics v_count = row_count;
  return v_count > 0;
end $$;

-- ---------------------------------------------------------------------------
-- Function access
-- ---------------------------------------------------------------------------
revoke execute on function public.voucher_funded(uuid, text) from public, anon, authenticated;
revoke execute on function public.voucher_defaults() from public, anon, authenticated;
revoke execute on function public.refresh_pledge_amount(uuid, text) from public, anon, authenticated;
revoke execute on function public.add_installments(uuid, text, date, text, numeric, int) from public, anon, authenticated;
revoke execute on function public.pledge_defaults() from public, anon, authenticated;
revoke execute on function public.pledge_schedule() from public, anon, authenticated;
revoke execute on function public.extend_open_pledges() from public, anon, authenticated;
revoke execute on function public.pledge_balance(uuid, text) from public, anon, authenticated;
revoke execute on function public.apply_to_pledge(uuid, text, text, numeric, text, text) from public, anon, authenticated;
revoke execute on function public.match_donation_to_pledge() from public, anon, authenticated;
revoke execute on function public.guard_matched_amount() from public, anon, authenticated;
revoke execute on function public.pledge_for_work(text) from public, anon, authenticated;

revoke execute on function public.add_voucher_funding(text, numeric, date, text, numeric) from public, anon;
revoke execute on function public.cancel_voucher(text, text) from public, anon;
revoke execute on function public.clear_voucher_overage(text) from public, anon;
revoke execute on function public.pay_pledge(text, numeric, text, text, text) from public, anon;
revoke execute on function public.match_pledge_payment(text, text, text) from public, anon;
revoke execute on function public.unmatch_pledge_payment(text, text) from public, anon;
revoke execute on function public.add_pledge_note(text, text) from public, anon;
revoke execute on function public.pledge_to_task(text) from public, anon;
revoke execute on function public.skip_installment(text, text) from public, anon;
revoke execute on function public.edit_installment(text, date, numeric) from public, anon;
revoke execute on function public.reschedule_pledge(text, numeric, text, date, int) from public, anon;
revoke execute on function public.cancel_pledge(text, text) from public, anon;
grant execute on function public.add_voucher_funding(text, numeric, date, text, numeric) to authenticated;
grant execute on function public.cancel_voucher(text, text) to authenticated;
grant execute on function public.clear_voucher_overage(text) to authenticated;
grant execute on function public.pay_pledge(text, numeric, text, text, text) to authenticated;
grant execute on function public.match_pledge_payment(text, text, text) to authenticated;
grant execute on function public.unmatch_pledge_payment(text, text) to authenticated;
grant execute on function public.add_pledge_note(text, text) to authenticated;
grant execute on function public.pledge_to_task(text) to authenticated;
grant execute on function public.skip_installment(text, text) to authenticated;
grant execute on function public.edit_installment(text, date, numeric) to authenticated;
grant execute on function public.reschedule_pledge(text, numeric, text, date, int) to authenticated;
grant execute on function public.cancel_pledge(text, text) to authenticated;

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
    raise exception 'Vouchers and pledges migration changed the balance of % campaign(s)', v_moved;
  end if;
end $$;

drop table _balances_before;
