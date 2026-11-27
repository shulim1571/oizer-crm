-- Readiness #29 (2026-11-15): signing off a bank statement checked the bank side only. Now the books are tied out too:
--   book balance = book opening + the period's book items (gifts, refunds, payouts, transfers; not ones set aside)
--                  + the differences explained on matches (bank fees, interest, processor fees)
--   book opening = last period's book balance; for the first period, the bank's opening balance plus items already
--                  in the books from before it that the bank hadn't cleared yet.
-- It has to equal the adjusted bank balance (statement + deposits in transit - outstanding payments), or the note has
-- to explain the difference; both are kept in the period's report. recon_tieout shows the comparison before signing.

create or replace function public.recon_book_figures(p_org uuid, p_account text, p_start date, p_end date, p_bank_opening numeric)
returns table (book_opening numeric, book_balance numeric)
language sql stable security definer set search_path = '' as $$
  with prev as (
    select x.report from public.bank_periods x
     where x.org_id = p_org and x.account_id = p_account and x.status = 'signed' and x.period_end < p_start
     order by x.period_end desc limit 1
  ), opening as (
    select coalesce(
      (select coalesce((p.report ->> 'book_balance')::numeric, (p.report ->> 'adjusted_balance')::numeric) from prev p),
      round(p_bank_opening, 2) + coalesce((select sum(o.amount) from public.recon_outstanding(p_org, p_account, p_end) o where o.item_date < p_start), 0)
    ) as v
  )
  select o.v,
         o.v + coalesce((select sum(b.amount) from public.recon_book_items(p_org, p_account) b
                          where b.item_date between p_start and p_end and not b.excluded), 0)
             + coalesce((select sum(m.difference) from public.recon_matches m
                          where m.org_id = p_org and m.account_id = p_account and m.difference <> 0
                            and exists (select 1 from public.bank_lines l where l.org_id = p_org and l.match_id = m.id
                                          and l.posted_date between p_start and p_end)), 0)
  from opening o
$$;
revoke execute on function public.recon_book_figures(uuid, text, date, date, numeric) from public, anon, authenticated;

-- The comparison, before signing off (what the page shows next to the adjusted bank balance).
create or replace function public.recon_tieout(p_account text, p_period_end date, p_statement_balance numeric,
                                               p_opening_balance numeric default null, p_period_start date default null)
returns table (book_balance numeric, adjusted_balance numeric, difference numeric)
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); prev public.bank_periods; v_start date; v_opening numeric; v_in numeric; v_out numeric; v_book numeric;
begin
  perform public.require_admin();
  perform public.recon_require_account(v_org, p_account);
  select * into prev from public.bank_periods x where x.org_id = v_org and x.account_id = p_account and x.status = 'signed' order by x.period_end desc limit 1;
  if prev.id is not null then v_start := prev.period_end + 1; v_opening := prev.statement_balance;
  else v_start := p_period_start; v_opening := p_opening_balance; end if;
  if v_start is null or v_opening is null or p_period_end is null or p_statement_balance is null then return; end if;
  select coalesce(sum(o.amount) filter (where o.amount > 0), 0), coalesce(sum(o.amount) filter (where o.amount < 0), 0)
    into v_in, v_out from public.recon_outstanding(v_org, p_account, p_period_end) o;
  select f.book_balance into v_book from public.recon_book_figures(v_org, p_account, v_start, p_period_end, v_opening) f;
  return query select round(v_book, 2), round(p_statement_balance, 2) + v_in + v_out, round(round(p_statement_balance, 2) + v_in + v_out - v_book, 2);
end $$;
revoke execute on function public.recon_tieout(text, date, numeric, numeric, date) from public, anon;
grant execute on function public.recon_tieout(text, date, numeric, numeric, date) to authenticated;

CREATE OR REPLACE FUNCTION public.sign_off_bank_period(p_account text, p_period_end date, p_statement_balance numeric, p_opening_balance numeric DEFAULT NULL::numeric, p_period_start date DEFAULT NULL::date, p_note text DEFAULT NULL::text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  v_book_opening numeric;
  v_book numeric;
  v_book_diff numeric;
begin
  perform public.require_mfa();
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

  -- Readiness #29: the books have to come to the adjusted bank balance, or the difference is explained in the note.
  select f.book_opening, f.book_balance into v_book_opening, v_book from public.recon_book_figures(v_org, p_account, v_start, p_period_end, v_opening) f;
  v_book_diff := round((v_report ->> 'adjusted_balance')::numeric - v_book, 2);
  if v_book_diff <> 0 and nullif(trim(p_note), '') is null then
    raise exception 'The books come to %, the adjusted bank balance to % (a difference of %). Find it, or explain it in the note to sign off anyway',
      to_char(v_book, 'FM999,999,990.00'), to_char((v_report ->> 'adjusted_balance')::numeric, 'FM999,999,990.00'), to_char(v_book_diff, 'FM999,999,990.00');
  end if;
  v_report := v_report || jsonb_build_object('book_opening', v_book_opening, 'book_balance', v_book, 'book_difference', v_book_diff);

  insert into public.bank_periods (org_id, account_id, period_start, period_end, opening_balance, statement_balance, lines_total, report, note)
  values (v_org, p_account, v_start, p_period_end, v_opening, round(p_statement_balance, 2), v_lines, v_report, nullif(trim(p_note), ''))
  returning id into v_id;
  return v_id;
end $function$

;
