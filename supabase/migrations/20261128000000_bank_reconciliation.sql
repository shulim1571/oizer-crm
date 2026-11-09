-- Phase 11, part 1: manual bank reconciliation. Bank statement lines come in from a CSV (Plaid comes later and
-- lands in the same table), are matched to what the books expect on that account, and each period is signed off
-- against the statement's ending balance. A matched payout clears its check. Moving money between bank accounts is
-- recorded as a bank transfer, and a cross-account campaign transfer asks for one on the Task Sheet.
-- No campaign balance changes here: reconciliation only reads the books.

-- The date an instant falls on where the organization is.
create or replace function public.org_date(p_at timestamptz) returns date
language sql stable set search_path = '' as $$
  select (p_at at time zone coalesce(
    (select s.value #>> '{}' from public.settings s where s.org_id = public.current_org_id() and s.key = 'timezone'),
    'America/New_York'))::date
$$;

-- ---------------------------------------------------------------------------
-- Tables. All admin only, and all changed only through the functions below.
-- ---------------------------------------------------------------------------
create table public.bank_imports (
  id          text not null default public.short_id(),
  org_id      uuid not null default public.current_org_id() references public.organizations(id),
  account_id  text not null,
  file_name   text,
  added       integer not null default 0,
  skipped     integer not null default 0,
  created_by  text default public.current_email(),
  created_at  timestamptz not null default now(),
  undone_by   text,
  undone_at   timestamptz,
  primary key (org_id, id),
  foreign key (org_id, account_id) references public.accounts (org_id, id) on update cascade
);

-- A difference is what the bank moved beyond the book items in the match: processor fees kept back from a card
-- deposit, a bank fee, interest, or something else, which needs a note.
create table public.recon_matches (
  id              text not null default public.short_id(),
  org_id          uuid not null default public.current_org_id() references public.organizations(id),
  account_id      text not null,
  kind            text not null check (kind in ('auto','manual')),
  lines_total     numeric(12,2) not null,
  items_total     numeric(12,2) not null,
  difference      numeric(12,2) not null,
  difference_type text check (difference_type in ('processor_fees','bank_fee','interest','other')),
  note            text,
  created_by      text default public.current_email(),
  created_at      timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, account_id) references public.accounts (org_id, id) on update cascade,
  check (difference = lines_total - items_total),
  check (difference = 0 or difference_type is not null)
);

create table public.bank_lines (
  id           text not null default public.short_id(),
  org_id       uuid not null default public.current_org_id() references public.organizations(id),
  account_id   text not null,
  posted_date  date not null,
  amount       numeric(12,2) not null check (amount <> 0),
  description  text,
  check_number text,
  bank_ref     text,
  source       text not null default 'import' check (source in ('import','manual','plaid')),
  import_id    text,
  -- The same statement line imported twice is recognized and skipped.
  fingerprint  text not null,
  match_id     text,
  created_by   text default public.current_email(),
  created_at   timestamptz not null default now(),
  primary key (org_id, id),
  unique (org_id, account_id, fingerprint),
  foreign key (org_id, account_id) references public.accounts (org_id, id) on update cascade,
  foreign key (org_id, import_id) references public.bank_imports (org_id, id),
  foreign key (org_id, match_id) references public.recon_matches (org_id, id)
);
create index bank_lines_org_account_date_idx on public.bank_lines (org_id, account_id, posted_date);
create index bank_lines_org_unmatched_idx on public.bank_lines (org_id, account_id) where match_id is null;
create index bank_lines_org_match_idx on public.bank_lines (org_id, match_id);

-- Each book item is in at most one match.
create table public.recon_match_items (
  org_id     uuid not null references public.organizations(id),
  match_id   text not null,
  item_type  text not null check (item_type in ('donation','donation_reversal','payout','bank_transfer_out','bank_transfer_in')),
  item_id    text not null,
  amount     numeric(12,2) not null,
  primary key (org_id, item_type, item_id),
  foreign key (org_id, match_id) references public.recon_matches (org_id, id) on delete cascade
);
create index recon_match_items_match_idx on public.recon_match_items (org_id, match_id);

-- Book items that never pass through this bank, such as opening balances brought over from the old system.
create table public.recon_exclusions (
  org_id     uuid not null default public.current_org_id() references public.organizations(id),
  item_type  text not null check (item_type in ('donation','donation_reversal','payout','bank_transfer_out','bank_transfer_in')),
  item_id    text not null,
  reason     text not null check (trim(reason) <> ''),
  created_by text default public.current_email(),
  created_at timestamptz not null default now(),
  primary key (org_id, item_type, item_id)
);

-- Money moved between two of the organization's bank accounts. No campaign balance changes.
create table public.bank_transfers (
  id                   text not null default public.short_id(),
  org_id               uuid not null default public.current_org_id() references public.organizations(id),
  from_account         text not null,
  to_account           text not null,
  amount               numeric(12,2) not null check (amount > 0),
  transfer_date        date not null,
  memo                 text,
  campaign_transfer_id text,
  created_by           text default public.current_email(),
  created_at           timestamptz not null default now(),
  deleted_by           text,
  deleted_at           timestamptz,
  primary key (org_id, id),
  foreign key (org_id, from_account) references public.accounts (org_id, id) on update cascade,
  foreign key (org_id, to_account) references public.accounts (org_id, id) on update cascade,
  foreign key (org_id, campaign_transfer_id) references public.transfers (org_id, id),
  check (from_account <> to_account)
);
create unique index bank_transfers_campaign_transfer_idx on public.bank_transfers (org_id, campaign_transfer_id)
  where campaign_transfer_id is not null and deleted_at is null;

-- A signed-off period locks every bank line up to its end. Only the latest can be reopened, by the Super Admin.
create table public.bank_periods (
  id                text not null default public.short_id(),
  org_id            uuid not null default public.current_org_id() references public.organizations(id),
  account_id        text not null,
  period_start      date not null,
  period_end        date not null,
  opening_balance   numeric(14,2) not null,
  statement_balance numeric(14,2) not null,
  lines_total       numeric(14,2) not null,
  report            jsonb not null,
  note              text,
  status            text not null default 'signed' check (status in ('signed','reopened')),
  signed_by         text default public.current_email(),
  signed_at         timestamptz not null default now(),
  reopened_by       text,
  reopened_at       timestamptz,
  reopen_reason     text,
  primary key (org_id, id),
  foreign key (org_id, account_id) references public.accounts (org_id, id) on update cascade,
  check (period_end >= period_start)
);
create unique index bank_periods_signed_idx on public.bank_periods (org_id, account_id, period_end) where status = 'signed';

-- ---------------------------------------------------------------------------
-- What the books expect on an account. Internal: the public wrapper checks the caller is an admin.
--   donation           a gift deposited here, on its check date if post-dated
--   donation_reversal  a refund or returned check taken back out, on its reversal date
--   payout             money paid out from here, on the check's date for a printed check
--   bank_transfer_*    money moved between the organization's own accounts
-- ---------------------------------------------------------------------------
create or replace function public.recon_book_items(p_org uuid, p_account text)
returns table (item_type text, item_id text, item_date date, amount numeric, fee numeric, payment_method text,
               description text, check_number text, campaign_id text, match_id text, excluded boolean, exclude_reason text)
language sql stable security definer set search_path = '' as $$
  with items as (
    select 'donation'::text as item_type, d.id as item_id,
           coalesce(case when d.post_dated then d.check_date end, public.org_date(d.created_at)) as item_date,
           d.amount, coalesce(d.fee, 0) as fee, d.payment_method,
           concat_ws(' · ', coalesce(d.payment_method, 'Payment'), nullif(coalesce(nullif(d.name, ''), d.donor_label), '')) as description,
           d.check_number, d.campaign_id
    from public.donations d
    where d.org_id = p_org and d.account_id = p_account and d.deleted_at is null and d.amount <> 0
      and d.status in ('completed','collect','refunded','returned')
    union all
    select 'donation_reversal', d.id, d.reversal_date, -d.amount, 0, d.payment_method,
           concat_ws(' · ', case when d.status = 'returned' then 'Returned' else 'Refund' end || ' ' || coalesce(d.payment_method, 'payment'),
                     nullif(coalesce(nullif(d.name, ''), d.donor_label), '')),
           d.check_number, d.campaign_id
    from public.donations d
    where d.org_id = p_org and d.account_id = p_account and d.deleted_at is null and d.amount <> 0
      and d.status in ('refunded','returned') and d.reversal_date is not null
    union all
    select 'payout', e.id, coalesce(k.check_date, public.org_date(e.processed_at)), -e.amount, 0, e.method,
           concat_ws(' · ', coalesce(e.method, 'Payout'), nullif(e.payee, '')),
           coalesce(k.check_number::text, nullif(e.check_number, '')), e.campaign_id
    from public.expenses e
    left join lateral (
      select x.check_number, x.check_date from public.checks x
      where x.org_id = e.org_id and x.expense_id = e.id and x.status in ('outstanding','cleared')
      order by x.issued_at desc limit 1
    ) k on true
    where e.org_id = p_org and e.account_id = p_account and e.deleted_at is null and e.processed_at is not null and e.amount <> 0
      -- A payout whose only checks were voided or lost hasn't left the bank.
      and not (k.check_number is null and exists (select 1 from public.checks x where x.org_id = e.org_id and x.expense_id = e.id))
    union all
    select 'bank_transfer_out', t.id, t.transfer_date, -t.amount, 0, null,
           'Transfer to ' || coalesce(a.name, t.to_account) || coalesce(' · ' || nullif(t.memo, ''), ''), null, null
    from public.bank_transfers t left join public.accounts a on a.org_id = t.org_id and a.id = t.to_account
    where t.org_id = p_org and t.from_account = p_account and t.deleted_at is null
    union all
    select 'bank_transfer_in', t.id, t.transfer_date, t.amount, 0, null,
           'Transfer from ' || coalesce(a.name, t.from_account) || coalesce(' · ' || nullif(t.memo, ''), ''), null, null
    from public.bank_transfers t left join public.accounts a on a.org_id = t.org_id and a.id = t.from_account
    where t.org_id = p_org and t.to_account = p_account and t.deleted_at is null
  )
  select i.item_type, i.item_id, i.item_date, i.amount, i.fee, i.payment_method, i.description, i.check_number, i.campaign_id,
         m.match_id, x.item_id is not null, x.reason
  from items i
  left join public.recon_match_items m on m.org_id = p_org and m.item_type = i.item_type and m.item_id = i.item_id
  left join public.recon_exclusions x on x.org_id = p_org and x.item_type = i.item_type and x.item_id = i.item_id
$$;

create or replace function public.bank_book_items(p_account text)
returns table (item_type text, item_id text, item_date date, amount numeric, fee numeric, payment_method text,
               description text, check_number text, campaign_id text, match_id text, excluded boolean, exclude_reason text)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
  perform public.require_admin();
  return query select * from public.recon_book_items(public.current_org_id(), p_account);
end $$;

-- The last day locked by a signed-off period, or null.
create or replace function public.bank_locked_through(p_org uuid, p_account text) returns date
language sql stable security definer set search_path = '' as $$
  select max(p.period_end) from public.bank_periods p where p.org_id = p_org and p.account_id = p_account and p.status = 'signed'
$$;

create or replace function public.recon_require_account(p_org uuid, p_account text) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.accounts a where a.org_id = p_org and a.id = p_account and a.deleted_at is null) then
    raise exception 'Bank account not found';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Bringing in bank lines
-- ---------------------------------------------------------------------------
-- p_lines: [{date: 'YYYY-MM-DD', amount: 12.34 (money in is positive), description, check_number, bank_ref}, ...]
create or replace function public.import_bank_lines(p_account text, p_file_name text, p_lines jsonb)
returns table (import_id text, added integer, skipped_duplicate integer, skipped_locked integer)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_org uuid := public.current_org_id();
  v_lock date;
  v_import text;
  v_total integer;
  v_locked integer;
  v_added integer;
begin
  perform public.require_admin();
  perform public.recon_require_account(v_org, p_account);
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'The file has no bank lines'; end if;
  if jsonb_array_length(p_lines) > 5000 then raise exception 'Import at most 5,000 lines at a time'; end if;
  v_lock := public.bank_locked_through(v_org, p_account);

  create temp table if not exists pg_temp.recon_incoming (n integer, posted_date date, amount numeric(12,2), description text,
                                                          check_number text, bank_ref text, fingerprint text) on commit drop;
  delete from pg_temp.recon_incoming;
  begin
    insert into pg_temp.recon_incoming (n, posted_date, amount, description, check_number, bank_ref)
    select x.n, (x.v ->> 'date')::date, round((x.v ->> 'amount')::numeric, 2),
           left(nullif(trim(x.v ->> 'description'), ''), 500),
           nullif(ltrim(regexp_replace(coalesce(x.v ->> 'check_number', ''), '\D', '', 'g'), '0'), ''),
           left(nullif(trim(x.v ->> 'bank_ref'), ''), 120)
    from jsonb_array_elements(p_lines) with ordinality as x(v, n);
  exception when invalid_datetime_format or datetime_field_overflow or invalid_text_representation or numeric_value_out_of_range then
    raise exception 'Some lines have a date or amount that can''t be read. Check the column choices and try again';
  end;
  if exists (select 1 from pg_temp.recon_incoming where posted_date is null or amount is null) then
    raise exception 'Every line needs a date and an amount. Line % doesn''t have both',
      (select min(n) from pg_temp.recon_incoming where posted_date is null or amount is null);
  end if;
  delete from pg_temp.recon_incoming where amount = 0;
  if exists (select 1 from pg_temp.recon_incoming where posted_date > public.org_today() + 1) then
    raise exception 'Line % is dated in the future', (select min(n) from pg_temp.recon_incoming where posted_date > public.org_today() + 1);
  end if;

  -- Identical lines in one file are real (two $18 deposits on the same day), so each copy is counted.
  update pg_temp.recon_incoming i set fingerprint = f.fp
  from (
    select r.n, md5(concat_ws('|', r.posted_date, r.amount, lower(coalesce(r.description, '')), coalesce(r.check_number, ''),
                              coalesce(r.bank_ref, ''),
                              row_number() over (partition by r.posted_date, r.amount, lower(coalesce(r.description, '')),
                                                 r.check_number, r.bank_ref order by r.n))) as fp
    from pg_temp.recon_incoming r
  ) f where f.n = i.n;

  select count(*) into v_total from pg_temp.recon_incoming;
  select count(*) into v_locked from pg_temp.recon_incoming where v_lock is not null and posted_date <= v_lock;

  insert into public.bank_imports (org_id, account_id, file_name) values (v_org, p_account, nullif(trim(p_file_name), ''))
  returning id into v_import;

  insert into public.bank_lines (org_id, account_id, posted_date, amount, description, check_number, bank_ref, source, import_id, fingerprint)
  select v_org, p_account, i.posted_date, i.amount, i.description, i.check_number, i.bank_ref, 'import', v_import, i.fingerprint
  from pg_temp.recon_incoming i
  where v_lock is null or i.posted_date > v_lock
  order by i.n
  on conflict (org_id, account_id, fingerprint) do nothing;
  get diagnostics v_added = row_count;

  update public.bank_imports set added = v_added, skipped = v_total - v_added where org_id = v_org and id = v_import;
  perform public.write_activity(v_org, 'bank_lines_imported', 'bank_imports', v_import, null,
    jsonb_build_object('account_id', p_account, 'file_name', p_file_name, 'added', v_added, 'skipped', v_total - v_added));
  return query select v_import, v_added, v_total - v_added - v_locked, v_locked;
end $$;

-- One line typed in by hand, for a bank that can't export a file.
create or replace function public.add_bank_line(p_account text, p_date date, p_amount numeric, p_description text,
                                                p_check_number text default null) returns text
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_id text := public.short_id();
begin
  perform public.require_admin();
  perform public.recon_require_account(v_org, p_account);
  if p_date is null or coalesce(p_amount, 0) = 0 then raise exception 'Enter the date and a non-zero amount'; end if;
  if p_date <= public.bank_locked_through(v_org, p_account) then
    raise exception 'That date is in a signed-off period. Reopen the period first';
  end if;
  insert into public.bank_lines (org_id, id, account_id, posted_date, amount, description, check_number, source, fingerprint)
  values (v_org, v_id, p_account, p_date, round(p_amount, 2), nullif(trim(p_description), ''),
          nullif(ltrim(regexp_replace(coalesce(p_check_number, ''), '\D', '', 'g'), '0'), ''), 'manual', 'manual:' || v_id);
  perform public.write_activity(v_org, 'bank_line_added', 'bank_lines', v_id, null,
    jsonb_build_object('account_id', p_account, 'date', p_date, 'amount', round(p_amount, 2)));
  return v_id;
end $$;

create or replace function public.delete_bank_line(p_line text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); l public.bank_lines;
begin
  perform public.require_admin();
  select * into l from public.bank_lines x where x.org_id = v_org and x.id = p_line for update;
  if l.id is null then raise exception 'Bank line not found'; end if;
  if l.match_id is not null then raise exception 'Unmatch this line first'; end if;
  if l.posted_date <= public.bank_locked_through(v_org, l.account_id) then raise exception 'This line is in a signed-off period'; end if;
  delete from public.bank_lines where org_id = v_org and id = p_line;
  perform public.write_activity(v_org, 'bank_line_deleted', 'bank_lines', p_line, null,
    jsonb_build_object('account_id', l.account_id, 'date', l.posted_date, 'amount', l.amount, 'description', l.description));
end $$;

-- Takes back a whole file, as long as none of its lines have been matched or locked.
create or replace function public.undo_bank_import(p_import text) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); i public.bank_imports; v_n integer;
begin
  perform public.require_admin();
  select * into i from public.bank_imports x where x.org_id = v_org and x.id = p_import for update;
  if i.id is null then raise exception 'Import not found'; end if;
  if i.undone_at is not null then raise exception 'This import was already undone'; end if;
  if exists (select 1 from public.bank_lines l where l.org_id = v_org and l.import_id = p_import and l.match_id is not null) then
    raise exception 'Some of its lines are matched. Unmatch them first';
  end if;
  if exists (select 1 from public.bank_lines l where l.org_id = v_org and l.import_id = p_import
             and l.posted_date <= public.bank_locked_through(v_org, i.account_id)) then
    raise exception 'Some of its lines are in a signed-off period';
  end if;
  delete from public.bank_lines where org_id = v_org and import_id = p_import;
  get diagnostics v_n = row_count;
  update public.bank_imports set undone_at = now(), undone_by = public.current_email() where org_id = v_org and id = p_import;
  perform public.write_activity(v_org, 'bank_import_undone', 'bank_imports', p_import, null, jsonb_build_object('lines_removed', v_n));
  return v_n;
end $$;

-- ---------------------------------------------------------------------------
-- Matching
-- ---------------------------------------------------------------------------
-- p_items: [{type, id}, ...]. Amounts always come from the books, never from the caller.
create or replace function public.recon_make_match(p_org uuid, p_account text, p_lines text[], p_items jsonb,
                                                   p_difference_type text, p_note text, p_kind text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_lock date := public.bank_locked_through(p_org, p_account);
  v_lines text[] := array(select distinct unnest(coalesce(p_lines, '{}')));
  v_items jsonb := coalesce(p_items, '[]'::jsonb);
  v_wanted integer;
  v_found integer;
  v_lines_total numeric;
  v_items_total numeric := 0;
  v_diff numeric;
  v_id text := public.short_id();
  v_note text := nullif(trim(p_note), '');
begin
  if cardinality(v_lines) = 0 then raise exception 'Choose at least one bank line'; end if;
  if (select count(*) from public.bank_lines l
      where l.org_id = p_org and l.id = any(v_lines) and l.account_id = p_account and l.match_id is null) <> cardinality(v_lines) then
    raise exception 'Some of those bank lines are already matched, or belong to another account';
  end if;
  if exists (select 1 from public.bank_lines l where l.org_id = p_org and l.id = any(v_lines) and l.posted_date <= v_lock) then
    raise exception 'Some of those bank lines are in a signed-off period';
  end if;
  select sum(l.amount) into v_lines_total from public.bank_lines l where l.org_id = p_org and l.id = any(v_lines);

  select count(distinct (x ->> 'type', x ->> 'id')) into v_wanted from jsonb_array_elements(v_items) x;
  if v_wanted > 0 then
    create temp table if not exists pg_temp.recon_pick (item_type text, item_id text, amount numeric, check_number text) on commit drop;
    delete from pg_temp.recon_pick;
    insert into pg_temp.recon_pick
    select b.item_type, b.item_id, b.amount, b.check_number
    from public.recon_book_items(p_org, p_account) b
    where (b.item_type, b.item_id) in (select x ->> 'type', x ->> 'id' from jsonb_array_elements(v_items) x)
      and b.match_id is null and not b.excluded;
    select count(*), coalesce(sum(amount), 0) into v_found, v_items_total from pg_temp.recon_pick;
    if v_found <> v_wanted then
      raise exception 'Some of those book items are already matched, set aside, or not on this account';
    end if;
  end if;

  v_diff := v_lines_total - v_items_total;
  if v_diff <> 0 and p_difference_type is null then
    raise exception 'The bank lines and book items differ by %. Say what the difference is', to_char(v_diff, 'FM999,999,990.00');
  end if;
  if p_difference_type is not null and p_difference_type not in ('processor_fees','bank_fee','interest','other') then
    raise exception 'Unknown kind of difference';
  end if;
  if v_diff <> 0 and p_difference_type = 'other' and v_note is null then raise exception 'Add a note explaining the difference'; end if;

  insert into public.recon_matches (org_id, id, account_id, kind, lines_total, items_total, difference, difference_type, note)
  values (p_org, v_id, p_account, p_kind, v_lines_total, v_items_total, v_diff, case when v_diff <> 0 then p_difference_type end, v_note);
  update public.bank_lines set match_id = v_id where org_id = p_org and id = any(v_lines);
  if v_wanted > 0 then
    insert into public.recon_match_items (org_id, match_id, item_type, item_id, amount)
    select p_org, v_id, item_type, item_id, amount from pg_temp.recon_pick;
    -- The bank paid these, so their checks have cleared.
    update public.checks k set status = 'cleared', status_by = public.current_email(), status_at = now()
    from pg_temp.recon_pick p
    where p.item_type = 'payout' and k.org_id = p_org and k.expense_id = p.item_id and k.status = 'outstanding';
    update public.expenses e set cleared = true
    from pg_temp.recon_pick p
    where p.item_type = 'payout' and e.org_id = p_org and e.id = p.item_id and e.cleared is not true;
  end if;
  return v_id;
end $$;

create or replace function public.match_bank(p_account text, p_lines text[], p_items jsonb default '[]',
                                             p_difference_type text default null, p_note text default null) returns text
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_id text; m public.recon_matches;
begin
  perform public.require_admin();
  perform public.recon_require_account(v_org, p_account);
  v_id := public.recon_make_match(v_org, p_account, p_lines, p_items, p_difference_type, p_note, 'manual');
  select * into m from public.recon_matches x where x.org_id = v_org and x.id = v_id;
  perform public.write_activity(v_org, 'bank_matched', 'recon_matches', v_id, null,
    jsonb_build_object('account_id', p_account, 'lines', cardinality(p_lines), 'items', jsonb_array_length(coalesce(p_items, '[]'::jsonb)),
                       'difference', m.difference, 'difference_type', m.difference_type, 'note', m.note));
  return v_id;
end $$;

create or replace function public.unmatch_bank(p_match text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); m public.recon_matches;
begin
  perform public.require_admin();
  select * into m from public.recon_matches x where x.org_id = v_org and x.id = p_match for update;
  if m.id is null then raise exception 'Match not found'; end if;
  if exists (select 1 from public.bank_lines l where l.org_id = v_org and l.match_id = p_match
             and l.posted_date <= public.bank_locked_through(v_org, m.account_id)) then
    raise exception 'This match is in a signed-off period. Reopen the period first';
  end if;
  -- Checks the match had cleared go back to outstanding.
  update public.checks k set status = 'outstanding', status_by = public.current_email(), status_at = now()
  from public.recon_match_items i
  where i.org_id = v_org and i.match_id = p_match and i.item_type = 'payout'
    and k.org_id = v_org and k.expense_id = i.item_id and k.status = 'cleared';
  update public.expenses e set cleared = false
  from public.recon_match_items i
  where i.org_id = v_org and i.match_id = p_match and i.item_type = 'payout' and e.org_id = v_org and e.id = i.item_id;
  update public.bank_lines set match_id = null where org_id = v_org and match_id = p_match;
  delete from public.recon_matches where org_id = v_org and id = p_match;
  perform public.write_activity(v_org, 'bank_unmatched', 'recon_matches', p_match, null,
    jsonb_build_object('account_id', m.account_id, 'lines_total', m.lines_total, 'items_total', m.items_total, 'kind', m.kind));
end $$;

-- Matches what can only go one way, and leaves everything uncertain for a person:
--   1. a cleared check: same check number and amount
--   2. one line and one book item with the same amount, close in date, and no other candidate on either side
--   3. a deposit that equals a day's gifts by one method (or all of that day's gifts), in full or less their
--      fees, again with no other candidate on either side
create or replace function public.auto_match_bank(p_account text) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  v_lock date;
  v_days integer;
  v_n integer := 0;
  r record;
begin
  perform public.require_admin();
  perform public.recon_require_account(v_org, p_account);
  v_lock := coalesce(public.bank_locked_through(v_org, p_account), '-infinity'::date);
  v_days := coalesce((select (s.value #>> '{}')::int from public.settings s where s.org_id = v_org and s.key = 'recon_match_days'), 10);

  -- 1. Checks by number.
  for r in
    select l.id as line_id, b.item_type, b.item_id
    from public.bank_lines l
    join public.recon_book_items(v_org, p_account) b
      on b.item_type = 'payout' and b.match_id is null and not b.excluded
     and ltrim(b.check_number, '0') = l.check_number and b.amount = l.amount
    where l.org_id = v_org and l.account_id = p_account and l.match_id is null and l.posted_date > v_lock and l.check_number is not null
  loop
    begin
      perform public.recon_make_match(v_org, p_account, array[r.line_id],
        jsonb_build_array(jsonb_build_object('type', r.item_type, 'id', r.item_id)), null, null, 'auto');
      v_n := v_n + 1;
    exception when others then null;  -- taken by an earlier pair this run
    end;
  end loop;

  -- 2. One to one.
  for r in
    with l as (
      select x.id, x.posted_date, x.amount from public.bank_lines x
      where x.org_id = v_org and x.account_id = p_account and x.match_id is null and x.posted_date > v_lock
    ), b as (
      select * from public.recon_book_items(v_org, p_account) y where y.match_id is null and not y.excluded
    ), c as (
      select l.id as line_id, b.item_type, b.item_id
      from l join b on b.amount = l.amount
       -- Checks can take months to clear; deposits land within days.
       and b.item_date between l.posted_date - case when l.amount < 0 then 120 else v_days end and l.posted_date + 3
    )
    select c.line_id, c.item_type, c.item_id from c
    where (select count(*) from c c2 where c2.line_id = c.line_id) = 1
      and (select count(*) from c c3 where c3.item_type = c.item_type and c3.item_id = c.item_id) = 1
  loop
    begin
      perform public.recon_make_match(v_org, p_account, array[r.line_id],
        jsonb_build_array(jsonb_build_object('type', r.item_type, 'id', r.item_id)), null, null, 'auto');
      v_n := v_n + 1;
    exception when others then null;
    end;
  end loop;

  -- 3. A day's deposit.
  for r in
    with l as (
      select x.id, x.posted_date, x.amount from public.bank_lines x
      where x.org_id = v_org and x.account_id = p_account and x.match_id is null and x.posted_date > v_lock and x.amount > 0
    ), b as (
      select * from public.recon_book_items(v_org, p_account) y
      where y.match_id is null and not y.excluded and y.item_type = 'donation'
    ), g as (
      select distinct on (ids) item_date, ids, gross, net, n from (
        select b.item_date, array_agg(b.item_id order by b.item_id) as ids, sum(b.amount) as gross, sum(b.amount - b.fee) as net, count(*) as n
        from b group by b.item_date, lower(coalesce(b.payment_method, ''))
        union all
        select b.item_date, array_agg(b.item_id order by b.item_id), sum(b.amount), sum(b.amount - b.fee), count(*)
        from b group by b.item_date
      ) z
    ), c as (
      select l.id as line_id, g.ids, case when g.gross = l.amount then null else 'processor_fees' end as diff_type
      from l join g on l.posted_date between g.item_date and g.item_date + 5
       and ((g.gross = l.amount and g.n > 1) or (g.net = l.amount and g.net <> g.gross))
    )
    select c.line_id, c.ids, c.diff_type from c
    where (select count(*) from c c2 where c2.line_id = c.line_id) = 1
      and (select count(*) from c c3 where c3.ids && c.ids) = 1
  loop
    begin
      perform public.recon_make_match(v_org, p_account, array[r.line_id],
        (select jsonb_agg(jsonb_build_object('type', 'donation', 'id', i)) from unnest(r.ids) i), r.diff_type, null, 'auto');
      v_n := v_n + 1;
    exception when others then null;
    end;
  end loop;

  if v_n > 0 then
    perform public.write_activity(v_org, 'bank_auto_matched', 'recon_matches', null, null,
      jsonb_build_object('account_id', p_account, 'matches', v_n));
  end if;
  return v_n;
end $$;

-- Setting aside a book item that never passes through this bank, and taking it back.
create or replace function public.exclude_book_item(p_type text, p_id text, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  perform public.require_admin();
  if nullif(trim(p_reason), '') is null then raise exception 'Give a reason'; end if;
  if p_type not in ('donation','donation_reversal','payout','bank_transfer_out','bank_transfer_in') then raise exception 'Unknown item'; end if;
  if not (
    (p_type in ('donation','donation_reversal') and exists (select 1 from public.donations d where d.org_id = v_org and d.id = p_id))
    or (p_type = 'payout' and exists (select 1 from public.expenses e where e.org_id = v_org and e.id = p_id))
    or (p_type like 'bank_transfer%' and exists (select 1 from public.bank_transfers t where t.org_id = v_org and t.id = p_id))) then
    raise exception 'Item not found';
  end if;
  if exists (select 1 from public.recon_match_items i where i.org_id = v_org and i.item_type = p_type and i.item_id = p_id) then
    raise exception 'This item is matched. Unmatch it first';
  end if;
  insert into public.recon_exclusions (org_id, item_type, item_id, reason) values (v_org, p_type, p_id, trim(p_reason))
  on conflict (org_id, item_type, item_id) do update set reason = excluded.reason, created_by = public.current_email(), created_at = now();
  perform public.write_activity(v_org, 'book_item_excluded', 'recon_exclusions', p_id, null,
    jsonb_build_object('item_type', p_type, 'reason', trim(p_reason)));
end $$;

create or replace function public.include_book_item(p_type text, p_id text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  perform public.require_admin();
  delete from public.recon_exclusions where org_id = v_org and item_type = p_type and item_id = p_id;
  if found then
    perform public.write_activity(v_org, 'book_item_included', 'recon_exclusions', p_id, null, jsonb_build_object('item_type', p_type));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Moving money between the organization's bank accounts
-- ---------------------------------------------------------------------------
create or replace function public.record_bank_transfer(p_from text, p_to text, p_amount numeric, p_date date,
                                                       p_memo text default null, p_campaign_transfer text default null) returns text
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_id text; t public.transfers;
begin
  perform public.require_admin();
  perform public.recon_require_account(v_org, p_from);
  perform public.recon_require_account(v_org, p_to);
  if p_from = p_to then raise exception 'Choose two different accounts'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'Enter an amount over zero'; end if;
  if p_date is null then raise exception 'Enter the date'; end if;
  if p_campaign_transfer is not null then
    select * into t from public.transfers x where x.org_id = v_org and x.id = p_campaign_transfer;
    if t.id is null or not t.cross_account then raise exception 'That campaign transfer isn''t a cross-account transfer'; end if;
    if round(p_amount, 2) <> t.amount then raise exception 'The campaign transfer was for %', to_char(t.amount, 'FM999,999,990.00'); end if;
    if exists (select 1 from public.bank_transfers b where b.org_id = v_org and b.campaign_transfer_id = t.id and b.deleted_at is null) then
      raise exception 'That campaign transfer already has its bank transfer';
    end if;
  end if;
  insert into public.bank_transfers (org_id, from_account, to_account, amount, transfer_date, memo, campaign_transfer_id)
  values (v_org, p_from, p_to, round(p_amount, 2), p_date, nullif(trim(p_memo), ''), p_campaign_transfer)
  returning id into v_id;
  if p_campaign_transfer is not null then
    update public.task_items set resolved_at = now()
    where org_id = v_org and task_key = 'bank_move_needed:' || p_campaign_transfer and resolved_at is null;
  end if;
  return v_id;
end $$;

create or replace function public.delete_bank_transfer(p_id text, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); t public.bank_transfers;
begin
  perform public.require_admin();
  if nullif(trim(p_reason), '') is null then raise exception 'Give a reason'; end if;
  select * into t from public.bank_transfers x where x.org_id = v_org and x.id = p_id and x.deleted_at is null for update;
  if t.id is null then raise exception 'Bank transfer not found'; end if;
  if exists (select 1 from public.recon_match_items i where i.org_id = v_org and i.item_id = p_id
             and i.item_type in ('bank_transfer_out','bank_transfer_in')) then
    raise exception 'This transfer is matched to the bank. Unmatch it first';
  end if;
  update public.bank_transfers set deleted_at = now(), deleted_by = public.current_email() where org_id = v_org and id = p_id;
  delete from public.recon_exclusions where org_id = v_org and item_id = p_id and item_type in ('bank_transfer_out','bank_transfer_in');
  if t.campaign_transfer_id is not null then
    update public.task_items set resolved_at = null
    where org_id = v_org and task_key = 'bank_move_needed:' || t.campaign_transfer_id;
  end if;
  perform public.write_activity(v_org, 'bank_transfer_deleted', 'bank_transfers', p_id, null, jsonb_build_object('reason', trim(p_reason)));
end $$;

-- A cross-account campaign transfer means money has to move between banks: it goes on the Task Sheet until it does.
create or replace function public.ask_for_bank_move() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_from text; v_to text;
begin
  if new.cross_account and new.from_campaign_id is not null and new.to_campaign_id is not null then
    v_from := coalesce(public.campaign_account(new.org_id, new.from_campaign_id), public.default_account(new.org_id));
    v_to := coalesce(public.campaign_account(new.org_id, new.to_campaign_id), public.default_account(new.org_id));
    insert into public.task_items (org_id, task_key, task_type, record_id, campaign_id, amount, summary, detail)
    values (new.org_id, 'bank_move_needed:' || new.id, 'bank_move_needed', new.id, new.from_campaign_id, new.amount,
            'Move ' || to_char(new.amount, 'FM$999,999,990.00') || ' from '
              || coalesce((select a.name from public.accounts a where a.org_id = new.org_id and a.id = v_from), 'no account')
              || ' to ' || coalesce((select a.name from public.accounts a where a.org_id = new.org_id and a.id = v_to), 'no account')
              || ' for campaign ' || new.from_campaign_id || ' → ' || new.to_campaign_id,
            jsonb_build_object('from_account', v_from, 'to_account', v_to))
    on conflict (org_id, task_key) do nothing;
  end if;
  return new;
end $$;
create trigger ask_for_bank_move after insert on public.transfers for each row execute function public.ask_for_bank_move();

-- ---------------------------------------------------------------------------
-- Periods
-- ---------------------------------------------------------------------------
-- What stood between the statement and the books on the last day: book items dated by then that the bank hadn't
-- shown yet (not matched, or matched only to later lines).
create or replace function public.recon_outstanding(p_org uuid, p_account text, p_end date)
returns table (item_type text, item_id text, item_date date, amount numeric, description text, check_number text)
language sql stable security definer set search_path = '' as $$
  select b.item_type, b.item_id, b.item_date, b.amount, b.description, b.check_number
  from public.recon_book_items(p_org, p_account) b
  where b.item_date <= p_end and not b.excluded
    and (b.match_id is null
         or (select min(l.posted_date) from public.bank_lines l where l.org_id = p_org and l.match_id = b.match_id) > p_end)
  order by b.item_date, b.item_type, b.item_id
$$;

create or replace function public.sign_off_bank_period(p_account text, p_period_end date, p_statement_balance numeric,
                                                       p_opening_balance numeric default null, p_period_start date default null,
                                                       p_note text default null) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  prev public.bank_periods;
  v_start date;
  v_opening numeric;
  v_lines numeric;
  v_open_lines integer;
  v_in numeric;
  v_out numeric;
  v_report jsonb;
  v_id text;
begin
  perform public.require_admin();
  perform public.recon_require_account(v_org, p_account);
  if p_period_end is null or p_statement_balance is null then raise exception 'Enter the statement''s end date and ending balance'; end if;
  if p_period_end > public.org_today() then raise exception 'The period can''t end in the future'; end if;
  select * into prev from public.bank_periods x where x.org_id = v_org and x.account_id = p_account and x.status = 'signed'
  order by x.period_end desc limit 1;
  if prev.id is not null then
    if p_period_end <= prev.period_end then
      raise exception 'Already signed off through %. The next period starts %', prev.period_end, prev.period_end + 1;
    end if;
    v_start := prev.period_end + 1;
    v_opening := prev.statement_balance;
    if p_opening_balance is not null and round(p_opening_balance, 2) <> v_opening then
      raise exception 'The opening balance is last period''s ending balance, %', to_char(v_opening, 'FM999,999,990.00');
    end if;
  else
    if p_opening_balance is null or p_period_start is null then
      raise exception 'For the first period, enter the statement''s start date and opening balance';
    end if;
    if p_period_start > p_period_end then raise exception 'The start date is after the end date'; end if;
    v_start := p_period_start;
    v_opening := round(p_opening_balance, 2);
  end if;

  select coalesce(sum(l.amount), 0), count(*) filter (where l.match_id is null) into v_lines, v_open_lines
  from public.bank_lines l
  where l.org_id = v_org and l.account_id = p_account and l.posted_date between v_start and p_period_end;
  if v_open_lines > 0 then
    raise exception '% bank % through % still need matching or explaining', v_open_lines,
      case when v_open_lines = 1 then 'line' else 'lines' end, to_char(p_period_end, 'FMMonth FMDD, YYYY');
  end if;
  if v_opening + v_lines <> round(p_statement_balance, 2) then
    raise exception 'The bank lines bring % to %, not the % entered. A line may be missing, or the balance mistyped',
      to_char(v_opening, 'FM999,999,990.00'), to_char(v_opening + v_lines, 'FM999,999,990.00'), to_char(p_statement_balance, 'FM999,999,990.00');
  end if;

  select coalesce(sum(o.amount) filter (where o.amount > 0), 0), coalesce(sum(o.amount) filter (where o.amount < 0), 0)
  into v_in, v_out from public.recon_outstanding(v_org, p_account, p_period_end) o;
  v_report := jsonb_build_object(
    'deposits_in_transit', v_in,
    'outstanding_payments', v_out,
    'adjusted_balance', round(p_statement_balance, 2) + v_in + v_out,
    'outstanding', coalesce((select jsonb_agg(to_jsonb(o)) from public.recon_outstanding(v_org, p_account, p_period_end) o), '[]'::jsonb),
    'differences', coalesce((
      select jsonb_agg(jsonb_build_object('type', d.difference_type, 'total', d.total, 'count', d.n) order by d.difference_type)
      from (
        select m.difference_type, sum(m.difference) as total, count(*) as n
        from public.recon_matches m
        where m.org_id = v_org and m.account_id = p_account and m.difference <> 0
          and exists (select 1 from public.bank_lines l where l.org_id = v_org and l.match_id = m.id and l.posted_date between v_start and p_period_end)
        group by m.difference_type
      ) d), '[]'::jsonb),
    'line_count', (select count(*) from public.bank_lines l where l.org_id = v_org and l.account_id = p_account
                   and l.posted_date between v_start and p_period_end),
    'deposits', (select coalesce(sum(l.amount), 0) from public.bank_lines l where l.org_id = v_org and l.account_id = p_account
                 and l.posted_date between v_start and p_period_end and l.amount > 0),
    'withdrawals', (select coalesce(sum(l.amount), 0) from public.bank_lines l where l.org_id = v_org and l.account_id = p_account
                    and l.posted_date between v_start and p_period_end and l.amount < 0)
  );

  insert into public.bank_periods (org_id, account_id, period_start, period_end, opening_balance, statement_balance, lines_total, report, note)
  values (v_org, p_account, v_start, p_period_end, v_opening, round(p_statement_balance, 2), v_lines, v_report, nullif(trim(p_note), ''))
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.reopen_bank_period(p_period text, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); p public.bank_periods;
begin
  if not public.is_super_admin() then raise exception 'Only the Super Admin can reopen a signed-off period'; end if;
  if nullif(trim(p_reason), '') is null then raise exception 'Give a reason'; end if;
  select * into p from public.bank_periods x where x.org_id = v_org and x.id = p_period and x.status = 'signed' for update;
  if p.id is null then raise exception 'Signed-off period not found'; end if;
  if exists (select 1 from public.bank_periods x where x.org_id = v_org and x.account_id = p.account_id and x.status = 'signed'
             and x.period_end > p.period_end) then
    raise exception 'Reopen the later periods first';
  end if;
  update public.bank_periods set status = 'reopened', reopened_by = public.current_email(), reopened_at = now(), reopen_reason = trim(p_reason)
  where org_id = v_org and id = p_period;
end $$;

-- One row per bank account, for the reconciliation screen.
create or replace function public.bank_reconciliation_summary()
returns table (account_id text, account_name text, unmatched_lines bigint, unmatched_total numeric, last_line_date date,
               locked_through date, last_statement_balance numeric, outstanding_checks bigint, outstanding_checks_total numeric)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare v_org uuid := public.current_org_id();
begin
  perform public.require_admin();
  return query
  select a.id, a.name,
         (select count(*) from public.bank_lines l where l.org_id = v_org and l.account_id = a.id and l.match_id is null),
         (select coalesce(sum(l.amount), 0) from public.bank_lines l where l.org_id = v_org and l.account_id = a.id and l.match_id is null),
         (select max(l.posted_date) from public.bank_lines l where l.org_id = v_org and l.account_id = a.id),
         public.bank_locked_through(v_org, a.id),
         (select p.statement_balance from public.bank_periods p where p.org_id = v_org and p.account_id = a.id and p.status = 'signed'
          order by p.period_end desc limit 1),
         (select count(*) from public.checks k where k.org_id = v_org and k.account_id = a.id and k.status = 'outstanding'),
         (select coalesce(sum(k.amount), 0) from public.checks k where k.org_id = v_org and k.account_id = a.id and k.status = 'outstanding')
  from public.accounts a
  where a.org_id = v_org and a.deleted_at is null
  order by a.name;
end $$;

-- Cross-account campaign transfers still waiting for their bank transfer.
create or replace view public.bank_moves_needed with (security_invoker = true) as
select t.id as transfer_id, t.amount, t.created_at, t.from_campaign_id, t.to_campaign_id, t.description,
       (i.detail ->> 'from_account') as from_account, (i.detail ->> 'to_account') as to_account
from public.task_items i
join public.transfers t on t.org_id = i.org_id and t.id = i.record_id
where i.task_type = 'bank_move_needed' and i.resolved_at is null and t.deleted_at is null
  and not exists (select 1 from public.task_sheet_actions a where a.org_id = i.org_id and a.task_key = i.task_key and a.action = 'dismissed');

-- ---------------------------------------------------------------------------
-- Row-level security and function access
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['bank_imports','bank_lines','recon_matches','recon_match_items','recon_exclusions','bank_transfers','bank_periods'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke insert, update, delete, truncate on public.%I from authenticated', t);
    execute format('create policy org_wall on public.%I as restrictive for all to authenticated
                    using (org_id = (select public.current_org_id()))
                    with check (org_id = (select public.current_org_id()))', t);
    execute format('create policy admin_read on public.%I for select to authenticated using ((select public.is_admin()))', t);
  end loop;
end $$;
-- Bank lines arrive by the thousand, so each import is logged once rather than every row.
create trigger log_row_change after insert or update or delete on public.recon_matches for each row execute function public.log_row_change();
create trigger log_row_change after insert or update or delete on public.bank_transfers for each row execute function public.log_row_change();
create trigger log_row_change after insert or update or delete on public.bank_periods for each row execute function public.log_row_change();

revoke all on public.bank_moves_needed from anon;
grant select on public.bank_moves_needed to authenticated;

revoke execute on function public.recon_book_items(uuid, text) from public, anon, authenticated;
revoke execute on function public.bank_locked_through(uuid, text) from public, anon, authenticated;
revoke execute on function public.recon_require_account(uuid, text) from public, anon, authenticated;
revoke execute on function public.recon_make_match(uuid, text, text[], jsonb, text, text, text) from public, anon, authenticated;
revoke execute on function public.recon_outstanding(uuid, text, date) from public, anon, authenticated;
revoke execute on function public.ask_for_bank_move() from public, anon, authenticated;
do $$
declare f text;
begin
  foreach f in array array[
    'org_date(timestamptz)',
    'bank_book_items(text)',
    'import_bank_lines(text, text, jsonb)',
    'add_bank_line(text, date, numeric, text, text)',
    'delete_bank_line(text)',
    'undo_bank_import(text)',
    'match_bank(text, text[], jsonb, text, text)',
    'unmatch_bank(text)',
    'auto_match_bank(text)',
    'exclude_book_item(text, text, text)',
    'include_book_item(text, text)',
    'record_bank_transfer(text, text, numeric, date, text, text)',
    'delete_bank_transfer(text, text)',
    'sign_off_bank_period(text, date, numeric, numeric, date, text)',
    'reopen_bank_period(text, text)',
    'bank_reconciliation_summary()'
  ] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
