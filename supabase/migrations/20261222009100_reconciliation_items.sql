-- Reconciliation from the inbox (Shulim, approved 2026-11-19; plan docs/review/org-inbox-plan-2026-11-19.md).
--   * card last 4 on gifts, from the feeds and Donor Base's own card charges (never more than the last 4);
--   * certificate lines under voucher batches;
--   * deposits read from emails (OJC / Pledger ACH, Chase check deposits), with their lines and suggested matches;
--   * deposit slips that group checks, so a bank's check-deposit notice matches one slip;
--   * the fee review list: a fee a report shows that differs from the one recorded waits for a person to confirm.
-- Nothing here posts by itself. Suggestions are stored; a person confirms each, through the functions at the end.

-- ---------------------------------------------------------------------------------------------------------------
-- Card last 4
-- ---------------------------------------------------------------------------------------------------------------
alter table public.donations add column if not exists card_last4 text check (card_last4 ~ '^[0-9]{4}$');

-- The digits at the end of whatever a feed sends (a masked number, the last 4, or nothing), or null.
create or replace function public.last4_of(p text) returns text
language sql immutable set search_path = '' as $$
  select case when right(regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g'), 4) ~ '^[0-9]{4}$'
              then right(regexp_replace(p, '[^0-9]', '', 'g'), 4) end
$$;

-- Make feed: Donary payments (last4Digits), Sola (masked card), Elevon (card number in payment_info).
do $$
declare v_def text; v_new text;
begin
  select pg_get_functiondef('public.make_new_donation'::regproc) into v_def;
  v_new := replace(v_def, 'anonymous, collector_label, notes, created_at, fee)', 'anonymous, collector_label, notes, created_at, fee, card_last4)');
  if v_new = v_def then raise exception 'make_new_donation: columns not found'; end if;
  v_def := v_new;
  v_new := replace(v_def, $s$public.make_time(d ->> 'created_at'), public.make_num(d ->> 'fee'));$s$,
                          $s$public.make_time(d ->> 'created_at'), public.make_num(d ->> 'fee'), public.last4_of(d ->> 'card_last4'));$s$);
  if v_new = v_def then raise exception 'make_new_donation: values not found'; end if;
  execute v_new;

  select pg_get_functiondef('public.make_ingest'::regproc) into v_def;
  v_new := replace(v_def, $s$'gateway_id', fp ->> 'gatewayRefNum', 'donary_id', fp ->> 'paymentNumber',$s$,
                          $s$'gateway_id', fp ->> 'gatewayRefNum', 'donary_id', fp ->> 'paymentNumber', 'card_last4', coalesce(fp ->> 'last4Digits', b ->> 'last4Digits'),$s$);
  if v_new = v_def then raise exception 'make_ingest: donary fields not found'; end if;
  v_def := v_new;
  v_new := replace(v_def, $s$'gateway_id', coalesce(b ->> 'xRefNum', b ->> 'xResponseRefNum'),$s$,
                          $s$'gateway_id', coalesce(b ->> 'xRefNum', b ->> 'xResponseRefNum'), 'card_last4', b ->> 'xMaskedCardNumber',$s$);
  if v_new = v_def then raise exception 'make_ingest: sola fields not found'; end if;
  v_def := v_new;
  v_new := replace(v_def, $s$'gateway_id', b -> 'payment_info' ->> 'referenceId',$s$,
                          $s$'gateway_id', b -> 'payment_info' ->> 'referenceId', 'card_last4', b -> 'payment_info' ->> 'card_number',$s$);
  if v_new = v_def then raise exception 'make_ingest: elevon fields not found'; end if;
  execute v_new;

  -- The direct Donary webhook.
  select pg_get_functiondef('public.donary_record_charge'::regproc) into v_def;
  v_new := replace(v_def, 'name, anonymous, notes, created_at, created_by, collector_label)', 'name, anonymous, notes, created_at, created_by, collector_label, card_last4)');
  if v_new = v_def then raise exception 'donary_record_charge: columns not found'; end if;
  v_def := v_new;
  v_new := regexp_replace(v_def, $r$(insert into public\.donations \(.*?card_last4\)\s+values \(.*?)\)\s*returning$r$,
                          $r$\1, public.last4_of(public.dj(p, 'last4Digits'))) returning$r$, 's');
  if v_new = v_def then raise exception 'donary_record_charge: values not found'; end if;
  execute v_new;

  -- Donor Base's own Sola charges (card and DAF card; not bank accounts).
  select pg_get_functiondef('public.record_gateway_result'::regproc) into v_def;
  v_new := regexp_replace(v_def, $r$(returning id into v_donation;)$r$,
                          $r$\1
    if g.method <> 'ach' and public.last4_of(v_masked) is not null then
      update public.donations set card_last4 = public.last4_of(v_masked) where org_id = p_org and id = v_donation;
    end if;$r$);
  if v_new = v_def then raise exception 'record_gateway_result: insert not found'; end if;
  execute v_new;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Certificate lines under voucher batches
-- ---------------------------------------------------------------------------------------------------------------
create table if not exists public.voucher_lines (
  org_id        uuid not null default public.current_org_id() references public.organizations(id),
  id            text not null default public.short_id(),
  voucher_id    text not null,
  cert_number   text not null,
  amount        numeric(12,2) not null check (amount > 0),
  donor_account text,                         -- the donor's DAF account #, as printed
  redeemed_on   date,
  status        text not null default 'submitted' check (status in ('submitted', 'in_review', 'pending', 'rejected', 'funded')),
  reported_fee  numeric(12,2),
  deposit_id    text,                         -- the deposit that paid it
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (org_id, id)
);
create unique index if not exists voucher_lines_once on public.voucher_lines (org_id, voucher_id, cert_number);
create index if not exists voucher_lines_cert on public.voucher_lines (org_id, cert_number);

-- ---------------------------------------------------------------------------------------------------------------
-- Deposit slips (checks grouped for one bank deposit)
-- ---------------------------------------------------------------------------------------------------------------
create table if not exists public.deposit_slips (
  org_id      uuid not null default public.current_org_id() references public.organizations(id),
  id          text not null default public.short_id(),
  slip_date   date not null default public.org_today(),
  account_id  text,
  total       numeric(12,2) not null default 0,
  check_count integer not null default 0,
  status      text not null default 'open' check (status in ('open', 'deposited')),
  deposit_id  text,                           -- the bank notice it was matched to
  notes       text,
  created_by  text default public.current_email(),
  created_at  timestamptz not null default now(),
  primary key (org_id, id)
);
alter table public.donations add column if not exists deposit_slip_id text;
create index if not exists donations_slip on public.donations (org_id, deposit_slip_id) where deposit_slip_id is not null;

-- ---------------------------------------------------------------------------------------------------------------
-- Deposits read from emails, and their lines
-- ---------------------------------------------------------------------------------------------------------------
create table if not exists public.deposits (
  org_id         uuid not null references public.organizations(id),
  id             text not null default public.short_id(),
  email_id       text,
  kind           text not null check (kind in ('ojc_ach', 'pledger_ach', 'ojc_submission', 'pledger_batch', 'bank_check_deposit')),
  issuer         text not null,               -- OJC, Pledger, Chase...
  issuer_ref     text,                        -- ACH id, batch id...
  deposit_date   date,
  gross          numeric(12,2),
  fees           numeric(12,2),
  net            numeric(12,2),
  account_last4  text,
  status         text not null default 'to_review' check (status in ('to_review', 'possible_duplicate', 'confirmed', 'dismissed')),
  duplicate_of   text,
  suggested_bank_line text,
  suggested_slip text,
  suggested_voucher text,
  read_notes     text,                        -- what the reader couldn't read, in plain words
  decided_by     text,
  decided_at     timestamptz,
  created_at     timestamptz not null default now(),
  primary key (org_id, id)
);
create index if not exists deposits_ref on public.deposits (org_id, kind, issuer_ref);

create table if not exists public.deposit_lines (
  org_id            uuid not null references public.organizations(id),
  id                text not null default public.short_id(),
  deposit_id        text not null,
  line_no           integer not null,
  kind              text not null check (kind in ('certificate', 'card', 'web', 'other')),
  ref               text,                     -- certificate, voucher or transaction number
  amount            numeric(12,2),
  fee               numeric(12,2),
  line_date         date,
  donor_name        text,
  donor_account     text,
  card_last4        text,
  trans_type        text,                     -- Pledger: Donary, Cartis Payments, AB Charity, Org web scan...
  cert_status       text,                     -- from a submission: ready / pending / rejected
  suggested_voucher_line text,
  suggested_donation text,
  candidates        integer not null default 0,
  outcome           text not null default 'open' check (outcome in ('open', 'matched', 'created', 'skipped')),
  donation_id       text,                     -- the gift it was matched to or created as
  primary key (org_id, id)
);
create index if not exists deposit_lines_deposit on public.deposit_lines (org_id, deposit_id, line_no);

-- ---------------------------------------------------------------------------------------------------------------
-- Fee reviews
-- ---------------------------------------------------------------------------------------------------------------
create table if not exists public.fee_reviews (
  org_id          uuid not null references public.organizations(id),
  id              text not null default public.short_id(),
  donation_id     text not null,
  recorded_fee    numeric(12,2),
  reported_fee    numeric(12,2) not null,
  source          text,                       -- e.g. "OJC ACH 1769123, line 3"
  deposit_line_id text,
  status          text not null default 'open' check (status in ('open', 'applied', 'dismissed')),
  decided_by      text,
  decided_at      timestamptz,
  created_at      timestamptz not null default now(),
  primary key (org_id, id)
);
create unique index if not exists fee_reviews_open_once on public.fee_reviews (org_id, donation_id) where status = 'open';

-- Row-level security: admins of the organization read these; changes go through the functions below
-- (voucher lines and slips can also be edited by admins directly).
do $$
declare t text;
begin
  foreach t in array array['voucher_lines', 'deposit_slips', 'deposits', 'deposit_lines', 'fee_reviews'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('drop policy if exists org_wall on public.%I', t);
    execute format('create policy org_wall on public.%I as restrictive for all to authenticated using (org_id = (select public.current_org_id())) with check (org_id = (select public.current_org_id()))', t);
    execute format('drop policy if exists admin_read on public.%I', t);
    execute format('create policy admin_read on public.%I for select to authenticated using ((select public.is_admin()))', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;
grant insert, update, delete on public.voucher_lines to authenticated;
drop policy if exists admin_write on public.voucher_lines;
create policy admin_write on public.voucher_lines for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
grant update on public.deposit_slips to authenticated;
drop policy if exists admin_write on public.deposit_slips;
create policy admin_write on public.deposit_slips for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

-- ---------------------------------------------------------------------------------------------------------------
-- Deposit slips: make one from checks, take a check off it
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.make_deposit_slip(p_donations text[], p_date date default null, p_account text default null, p_notes text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_id text; v_n integer; v_total numeric; v_bad integer;
begin
  perform public.require_admin();
  if coalesce(array_length(p_donations, 1), 0) = 0 then raise exception 'Choose the checks to put on the slip'; end if;
  select count(*) into v_bad from public.donations d
   where d.org_id = v_org and d.id = any(p_donations)
     and (d.deleted_at is not null or d.status not in ('completed', 'collect')
          or not exists (select 1 from public.payment_methods m where m.org_id = v_org and m.name = d.payment_method and m.is_check)
          or d.deposit_slip_id is not null);
  if v_bad > 0 then raise exception 'Only checks that are recorded and not already on a slip can go on a deposit slip (% of those chosen can''t)', v_bad; end if;
  select count(*), coalesce(sum(d.amount), 0) into v_n, v_total from public.donations d where d.org_id = v_org and d.id = any(p_donations);
  if v_n <> array_length(p_donations, 1) then raise exception 'Some of the checks weren''t found'; end if;
  insert into public.deposit_slips (org_id, slip_date, account_id, total, check_count, notes)
  values (v_org, coalesce(p_date, public.org_today()), p_account, v_total, v_n, nullif(trim(p_notes), ''))
  returning id into v_id;
  update public.donations set deposit_slip_id = v_id where org_id = v_org and id = any(p_donations);
  return v_id;
end $$;
revoke execute on function public.make_deposit_slip(text[], date, text, text) from public, anon;
grant execute on function public.make_deposit_slip(text[], date, text, text) to authenticated;

create or replace function public.remove_from_deposit_slip(p_donation text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_slip text;
begin
  perform public.require_admin();
  select deposit_slip_id into v_slip from public.donations where org_id = v_org and id = p_donation;
  if v_slip is null then return; end if;
  update public.donations set deposit_slip_id = null where org_id = v_org and id = p_donation;
  update public.deposit_slips s set total = coalesce((select sum(d.amount) from public.donations d where d.org_id = v_org and d.deposit_slip_id = v_slip), 0),
         check_count = (select count(*) from public.donations d where d.org_id = v_org and d.deposit_slip_id = v_slip)
   where s.org_id = v_org and s.id = v_slip;
end $$;
revoke execute on function public.remove_from_deposit_slip(text) from public, anon;
grant execute on function public.remove_from_deposit_slip(text) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- Recording what a reader read (called by email-inbound with the secret key), with suggested matches
-- ---------------------------------------------------------------------------------------------------------------
-- p: { kind, issuer, issuer_ref, deposit_date, gross, fees, net, account_last4, notes,
--      lines: [{ kind, ref, amount, fee, line_date, donor_name, donor_account, card_last4, trans_type, cert_status }] }
create or replace function public.inbox_record_deposit(p_org uuid, p_email text, p jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare v_id text; v_dup text; l jsonb; n integer := 0; v_vl text; v_don text; v_cnt integer; v_slip text; v_bank text; v_voucher text;
        v_date date := nullif(p ->> 'deposit_date', '')::date; v_net numeric := nullif(p ->> 'net', '')::numeric;
        v_kind text := p ->> 'kind';
begin
  -- The same deposit seen before (a second forward): kept, flagged.
  select d.id into v_dup from public.deposits d
   where d.org_id = p_org and d.kind = v_kind and d.issuer_ref is not distinct from nullif(p ->> 'issuer_ref', '')
     and (nullif(p ->> 'issuer_ref', '') is not null or (d.deposit_date = v_date and d.net is not distinct from v_net))
     and d.status <> 'dismissed'
   order by d.created_at limit 1;
  insert into public.deposits (org_id, email_id, kind, issuer, issuer_ref, deposit_date, gross, fees, net, account_last4, read_notes, status, duplicate_of)
  values (p_org, p_email, v_kind, coalesce(p ->> 'issuer', 'Unknown'), nullif(p ->> 'issuer_ref', ''), v_date,
          nullif(p ->> 'gross', '')::numeric, nullif(p ->> 'fees', '')::numeric, v_net, public.last4_of(p ->> 'account_last4'),
          nullif(p ->> 'notes', ''), case when v_dup is not null then 'possible_duplicate' else 'to_review' end, v_dup)
  returning id into v_id;

  for l in select * from jsonb_array_elements(coalesce(p -> 'lines', '[]'::jsonb)) loop
    n := n + 1; v_vl := null; v_don := null; v_cnt := 0;
    if l ->> 'kind' = 'certificate' and nullif(l ->> 'ref', '') is not null then
      -- A certificate: its line under a voucher batch, by certificate number (and amount, when two share a number).
      select x.id into v_vl from public.voucher_lines x
       where x.org_id = p_org and x.cert_number = trim(l ->> 'ref')
       order by (x.amount = nullif(l ->> 'amount', '')::numeric) desc, (x.status = 'funded'), x.created_at limit 1;
    elsif l ->> 'kind' in ('card', 'web') and nullif(l ->> 'amount', '') is not null then
      -- A card or web gift: same amount, a day either side, and the same card's last 4 when both are known.
      select count(*), min(d.id) into v_cnt, v_don from public.donations d
       where d.org_id = p_org and d.deleted_at is null and d.status in ('completed', 'collect')
         and d.amount = (l ->> 'amount')::numeric
         and (nullif(l ->> 'line_date', '') is null or (d.created_at at time zone public.org_zone(p_org))::date
                between (l ->> 'line_date')::date - 1 and (l ->> 'line_date')::date + 1)
         and (public.last4_of(l ->> 'card_last4') is null or d.card_last4 is null or d.card_last4 = public.last4_of(l ->> 'card_last4'));
      if v_cnt <> 1 then v_don := null; end if;
    end if;
    insert into public.deposit_lines (org_id, deposit_id, line_no, kind, ref, amount, fee, line_date, donor_name, donor_account, card_last4,
                                      trans_type, cert_status, suggested_voucher_line, suggested_donation, candidates)
    values (p_org, v_id, n, coalesce(l ->> 'kind', 'other'), nullif(trim(l ->> 'ref'), ''), nullif(l ->> 'amount', '')::numeric,
            nullif(l ->> 'fee', '')::numeric, nullif(l ->> 'line_date', '')::date, left(nullif(trim(l ->> 'donor_name'), ''), 200),
            nullif(trim(l ->> 'donor_account'), ''), public.last4_of(l ->> 'card_last4'), nullif(trim(l ->> 'trans_type'), ''),
            nullif(lower(trim(l ->> 'cert_status')), ''), v_vl, v_don, v_cnt);
  end loop;

  -- The deposit as a whole: a bank line of the net (1–5 days after), a slip of the same total (checks), the voucher batch.
  if v_net is not null and v_kind in ('ojc_ach', 'pledger_ach', 'bank_check_deposit') then
    select b.id into v_bank from public.bank_lines b
     where b.org_id = p_org and b.amount = v_net and b.match_id is null
       and (v_date is null or b.posted_date between v_date - 1 and v_date + 5)
     order by abs(b.posted_date - coalesce(v_date, b.posted_date)) limit 1;
  end if;
  if v_kind = 'bank_check_deposit' and v_net is not null then
    select s.id into v_slip from public.deposit_slips s
     where s.org_id = p_org and s.status = 'open' and s.total = v_net and (v_date is null or s.slip_date between v_date - 7 and v_date)
     order by s.slip_date desc limit 1;
  end if;
  if v_kind in ('ojc_submission', 'pledger_batch') and nullif(p ->> 'issuer_ref', '') is not null then
    select v.id into v_voucher from public.vouchers v
     where v.org_id = p_org and v.deleted_at is null and (v.issuer_number = p ->> 'issuer_ref' or v.issuer_reference = p ->> 'issuer_ref')
     limit 1;
  end if;
  update public.deposits set suggested_bank_line = v_bank, suggested_slip = v_slip, suggested_voucher = v_voucher where org_id = p_org and id = v_id;
  perform public.deposit_task_sync(p_org, v_id);
  return v_id;
end $$;
revoke execute on function public.inbox_record_deposit(uuid, text, jsonb) from public, anon, authenticated;

create or replace function public.deposit_task_sync(p_org uuid, p_deposit text) returns void
language plpgsql security definer set search_path = '' as $$
declare d public.deposits; v_lines integer; v_sugg integer;
begin
  select * into d from public.deposits where org_id = p_org and id = p_deposit;
  if d.id is null then return; end if;
  if d.status in ('to_review', 'possible_duplicate') then
    select count(*), count(*) filter (where suggested_voucher_line is not null or suggested_donation is not null)
      into v_lines, v_sugg from public.deposit_lines where org_id = p_org and deposit_id = p_deposit;
    insert into public.task_items (org_id, task_key, task_type, record_id, amount, summary)
    values (p_org, 'deposit_review:' || d.id, 'deposit_review', d.id, d.net,
            left(case when d.status = 'possible_duplicate' then 'Possible duplicate: ' else '' end || d.issuer || ' ' ||
                 case d.kind when 'ojc_ach' then 'ACH' when 'pledger_ach' then 'ACH' when 'bank_check_deposit' then 'check deposit'
                             else 'submission' end ||
                 coalesce(' ' || d.issuer_ref, '') || coalesce(' · ' || to_char(d.net, 'FM$999,999,990.00'), '') ||
                 case when v_lines > 0 then format(' · %s line%s, %s with a suggested match', v_lines, case when v_lines = 1 then '' else 's' end, v_sugg) else '' end, 300))
    on conflict (org_id, task_key) do update set summary = excluded.summary, amount = excluded.amount, resolved_at = null;
  else
    update public.task_items set resolved_at = now() where org_id = p_org and task_key = 'deposit_review:' || d.id and resolved_at is null;
  end if;
end $$;
revoke execute on function public.deposit_task_sync(uuid, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- What a person does in review
-- ---------------------------------------------------------------------------------------------------------------
-- A line: match it to the suggested (or a chosen) certificate line / gift, create the missing gift, or skip it.
create or replace function public.deposit_line_decide(p_line text, p_action text, p_target text default null, p_campaign text default null,
                                                      p_method text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); l public.deposit_lines; d public.deposits; v_target text; v_don text; v_donor text; dn public.donations;
begin
  perform public.require_admin();
  select * into l from public.deposit_lines where org_id = v_org and id = p_line for update;
  if l.id is null then raise exception 'Line not found'; end if;
  select * into d from public.deposits where org_id = v_org and id = l.deposit_id;
  if d.status in ('confirmed', 'dismissed') then raise exception 'This deposit is already done'; end if;
  if p_action = 'skip' then
    update public.deposit_lines set outcome = 'skipped' where org_id = v_org and id = p_line;
  elsif p_action = 'reopen' then
    update public.deposit_lines set outcome = 'open', donation_id = null where org_id = v_org and id = p_line;
  elsif p_action = 'match' and l.kind = 'certificate' then
    v_target := coalesce(p_target, l.suggested_voucher_line);
    if not exists (select 1 from public.voucher_lines x where x.org_id = v_org and x.id = v_target) then raise exception 'Choose the certificate line it pays'; end if;
    update public.deposit_lines set outcome = 'matched', suggested_voucher_line = v_target where org_id = v_org and id = p_line;
  elsif p_action = 'match' then
    v_target := coalesce(p_target, l.suggested_donation);
    select * into dn from public.donations x where x.org_id = v_org and x.id = v_target and x.deleted_at is null;
    if dn.id is null then raise exception 'Choose the gift this line is'; end if;
    update public.deposit_lines set outcome = 'matched', donation_id = dn.id, suggested_donation = dn.id where org_id = v_org and id = p_line;
    -- Card last 4 learned from the report, when the gift had none.
    if dn.card_last4 is null and l.card_last4 is not null then
      update public.donations set card_last4 = l.card_last4 where org_id = v_org and id = dn.id;
    end if;
    -- A different real fee waits for a person to confirm it (never applied here).
    if l.fee is not null and l.fee is distinct from dn.fee then
      insert into public.fee_reviews (org_id, donation_id, recorded_fee, reported_fee, source, deposit_line_id)
      values (v_org, dn.id, dn.fee, l.fee, format('%s %s, line %s', d.issuer, coalesce(d.issuer_ref, ''), l.line_no), l.id)
      on conflict (org_id, donation_id) where status = 'open' do update set reported_fee = excluded.reported_fee, source = excluded.source;
      perform public.fee_review_task_sync(v_org, dn.id);
    end if;
  elsif p_action = 'create' then
    if l.amount is null or l.amount <= 0 then raise exception 'This line has no amount to record'; end if;
    if nullif(trim(p_campaign), '') is null then raise exception 'Choose the campaign for this gift'; end if;
    -- The donor: by their DAF account number on file, else by name, else a new donor from the report's name.
    select x.id into v_donor from public.donors x
     where x.org_id = v_org and x.deleted_at is null and l.donor_account is not null
       and ((d.issuer ilike 'OJC%' and x.ojc_id = l.donor_account) or (d.issuer ilike 'Pledger%' and x.pledger_id = l.donor_account))
     limit 1;
    if v_donor is null and l.donor_name is not null and l.donor_name !~* '^anonymous$' then
      select x.id into v_donor from public.donors x
       where x.org_id = v_org and x.deleted_at is null and lower(x.display_name) = lower(l.donor_name) limit 1;
      if v_donor is null then
        insert into public.donors (org_id, first_name, last_name, ojc_id, pledger_id, notes)
        values (v_org, split_part(l.donor_name, ' ', 1), nullif(substr(l.donor_name, length(split_part(l.donor_name, ' ', 1)) + 2), ''),
                case when d.issuer ilike 'OJC%' then l.donor_account end, case when d.issuer ilike 'Pledger%' then l.donor_account end,
                format('Added from %s %s', d.issuer, coalesce(d.issuer_ref, '')))
        returning id into v_donor;
      end if;
    end if;
    -- The method follows the issuer (fees follow the method): e.g. an OJC card gift is "OJC".
    insert into public.donations (org_id, campaign_id, donor_id, name, amount, payment_method, type, status, card_last4, bank_reference, created_at, notes)
    values (v_org, p_campaign, v_donor, case when v_donor is null then coalesce(l.donor_name, 'Anonymous') end, l.amount,
            coalesce(nullif(trim(p_method), ''), d.issuer), 'Payment', 'completed', l.card_last4, d.issuer_ref,
            coalesce(l.line_date::timestamp, d.deposit_date::timestamp, now()) at time zone public.org_zone(v_org),
            format('From %s %s, line %s', d.issuer, coalesce(d.issuer_ref, ''), l.line_no))
    returning id into v_don;
    update public.deposit_lines set outcome = 'created', donation_id = v_don where org_id = v_org and id = p_line;
    select * into dn from public.donations where org_id = v_org and id = v_don;
    if l.fee is not null and l.fee is distinct from dn.fee then
      insert into public.fee_reviews (org_id, donation_id, recorded_fee, reported_fee, source, deposit_line_id)
      values (v_org, v_don, dn.fee, l.fee, format('%s %s, line %s', d.issuer, coalesce(d.issuer_ref, ''), l.line_no), l.id)
      on conflict (org_id, donation_id) where status = 'open' do nothing;
      perform public.fee_review_task_sync(v_org, v_don);
    end if;
  else
    raise exception 'Unknown action';
  end if;
  perform public.deposit_task_sync(v_org, l.deposit_id);
  return coalesce(v_don, v_target);
end $$;
revoke execute on function public.deposit_line_decide(text, text, text, text, text) from public, anon;
grant execute on function public.deposit_line_decide(text, text, text, text, text) to authenticated;

-- The deposit: confirm it (matched certificates are funded through the voucher's own funding, a slip is marked
-- deposited) or dismiss it. Bank lines are matched on the Reconciliation screen, where the suggestion is shown.
create or replace function public.deposit_decide(p_deposit text, p_action text, p_slip text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); d public.deposits; g record; v_funded integer := 0; v_open integer; v_slip text;
begin
  perform public.require_admin();
  select * into d from public.deposits where org_id = v_org and id = p_deposit for update;
  if d.id is null then raise exception 'Deposit not found'; end if;
  if d.status in ('confirmed', 'dismissed') then raise exception 'This deposit is already done'; end if;
  if p_action = 'dismiss' then
    update public.deposits set status = 'dismissed', decided_by = public.current_email(), decided_at = now() where org_id = v_org and id = p_deposit;
  elsif p_action = 'not_duplicate' then
    update public.deposits set status = 'to_review', duplicate_of = null where org_id = v_org and id = p_deposit;
  elsif p_action = 'confirm' then
    select count(*) into v_open from public.deposit_lines where org_id = v_org and deposit_id = p_deposit and outcome = 'open';
    if v_open > 0 then raise exception '% line% still need a decision (match, create or skip)', v_open, case when v_open = 1 then '' else 's' end; end if;
    if d.kind in ('ojc_ach', 'pledger_ach') then
      -- Matched certificates: each voucher batch is funded with what this deposit paid toward it.
      for g in select x.voucher_id, sum(l.amount) as amt
                 from public.deposit_lines l join public.voucher_lines x on x.org_id = l.org_id and x.id = l.suggested_voucher_line
                where l.org_id = v_org and l.deposit_id = p_deposit and l.outcome = 'matched' and l.kind = 'certificate' and x.status <> 'funded'
                group by x.voucher_id loop
        perform public.add_voucher_funding(g.voucher_id, g.amt, d.deposit_date, coalesce(d.issuer || ' ' || d.issuer_ref, d.issuer), null);
        v_funded := v_funded + 1;
      end loop;
      update public.voucher_lines x set status = 'funded', deposit_id = p_deposit,
             reported_fee = coalesce(l.fee, x.reported_fee), updated_at = now()
        from public.deposit_lines l
       where l.org_id = v_org and l.deposit_id = p_deposit and l.outcome = 'matched' and l.kind = 'certificate'
         and x.org_id = v_org and x.id = l.suggested_voucher_line;
    elsif d.kind in ('ojc_submission', 'pledger_batch') then
      -- A submission: its certificates are recorded under the voucher batch with the status the issuer gave.
      if d.suggested_voucher is null then raise exception 'Choose the voucher batch this submission is for first'; end if;
      insert into public.voucher_lines (org_id, voucher_id, cert_number, amount, donor_account, redeemed_on, status, reported_fee)
      select v_org, d.suggested_voucher, l.ref, l.amount, l.donor_account, l.line_date,
             case when l.cert_status in ('pending') then 'pending' when l.cert_status in ('rejected') then 'rejected'
                  when l.cert_status in ('review', 'in_review') then 'in_review' else 'submitted' end, l.fee
        from public.deposit_lines l
       where l.org_id = v_org and l.deposit_id = p_deposit and l.outcome = 'matched' and l.ref is not null and l.amount > 0
      on conflict (org_id, voucher_id, cert_number) do update set status = excluded.status, amount = excluded.amount, updated_at = now();
    elsif d.kind = 'bank_check_deposit' then
      v_slip := coalesce(p_slip, d.suggested_slip);
      if v_slip is not null then
        update public.deposit_slips set status = 'deposited', deposit_id = p_deposit where org_id = v_org and id = v_slip;
      end if;
    end if;
    update public.deposits set status = 'confirmed', suggested_slip = coalesce(v_slip, suggested_slip),
           decided_by = public.current_email(), decided_at = now()
     where org_id = v_org and id = p_deposit;
  else
    raise exception 'Unknown action';
  end if;
  perform public.deposit_task_sync(v_org, p_deposit);
  return jsonb_build_object('vouchers_funded', v_funded, 'slip', v_slip);
end $$;
revoke execute on function public.deposit_decide(text, text, text) from public, anon;
grant execute on function public.deposit_decide(text, text, text) to authenticated;

-- A submission's lines are "matched" to mean "record this certificate": one step for all of them.
create or replace function public.deposit_set_voucher(p_deposit text, p_voucher text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  perform public.require_admin();
  if not exists (select 1 from public.vouchers v where v.org_id = v_org and v.id = p_voucher and v.deleted_at is null) then raise exception 'Voucher batch not found'; end if;
  update public.deposits set suggested_voucher = p_voucher where org_id = v_org and id = p_deposit and status in ('to_review', 'possible_duplicate');
  update public.deposit_lines set outcome = 'matched' where org_id = v_org and deposit_id = p_deposit and outcome = 'open' and ref is not null
     and exists (select 1 from public.deposits d where d.org_id = v_org and d.id = p_deposit and d.kind in ('ojc_submission', 'pledger_batch'));
  perform public.deposit_task_sync(v_org, p_deposit);
end $$;
revoke execute on function public.deposit_set_voucher(text, text) from public, anon;
grant execute on function public.deposit_set_voucher(text, text) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- Fee reviews: apply the reported fee (as the gift's fee, kept from then on) or keep the recorded one
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.fee_review_task_sync(p_org uuid, p_donation text) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.fee_reviews;
begin
  select * into r from public.fee_reviews where org_id = p_org and donation_id = p_donation and status = 'open';
  if r.id is not null then
    insert into public.task_items (org_id, task_key, task_type, record_id, amount, summary)
    values (p_org, 'fee_review:' || p_donation, 'fee_review', p_donation, r.reported_fee,
            left(format('Fee differs: recorded %s, %s says %s', coalesce(to_char(r.recorded_fee, 'FM$999,990.00'), 'none'),
                        coalesce(r.source, 'a report'), to_char(r.reported_fee, 'FM$999,990.00')), 300))
    on conflict (org_id, task_key) do update set summary = excluded.summary, amount = excluded.amount, resolved_at = null;
  else
    update public.task_items set resolved_at = now() where org_id = p_org and task_key = 'fee_review:' || p_donation and resolved_at is null;
  end if;
end $$;
revoke execute on function public.fee_review_task_sync(uuid, text) from public, anon, authenticated;

create or replace function public.fee_review_decide(p_review text, p_action text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); r public.fee_reviews;
begin
  if not public.has_super_permission('configure_fees') then raise exception 'Only an admin who can change fees can decide fee reviews'; end if;
  select * into r from public.fee_reviews where org_id = v_org and id = p_review for update;
  if r.id is null or r.status <> 'open' then raise exception 'This fee review is already decided'; end if;
  if p_action = 'apply' then
    -- As a manual fee, so it stays put (Moshe's rule: a fee stays as it is unless a person changes it).
    update public.donations set manual_fee = r.reported_fee where org_id = v_org and id = r.donation_id;
    update public.fee_reviews set status = 'applied', decided_by = public.current_email(), decided_at = now() where org_id = v_org and id = p_review;
  elsif p_action = 'dismiss' then
    update public.fee_reviews set status = 'dismissed', decided_by = public.current_email(), decided_at = now() where org_id = v_org and id = p_review;
  else
    raise exception 'Unknown action';
  end if;
  perform public.fee_review_task_sync(v_org, r.donation_id);
end $$;
revoke execute on function public.fee_review_decide(text, text) from public, anon;
grant execute on function public.fee_review_decide(text, text) to authenticated;
