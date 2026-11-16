-- Readiness #17 (2026-11-15): partial refunds in the app, disputed gifts, chargebacks.
--
-- * Refund part of a gift, by hand or through Sola: the refunded part is its own negative transaction linked to
--   the gift (as Make's refunds already are, readiness #4), so the rest keeps counting. A $30 refund on $100 leaves
--   $70 counted. Refunding what's left marks the gift refunded and folds the earlier parts into it.
-- * Disputed: a card gift the donor's bank is disputing is held out of the balance (not raised) while it's open;
--   its processing fee stays spent. It's on the Task Sheet until it's settled: won (back to completed) or lost.
-- * Chargeback: a lost dispute (or a chargeback straight away) takes the gift out for good and records the
--   processor's chargeback fee as its own figure (chargeback_fee), which comes off the campaign balance.
-- A dispute is usually settled within weeks, so a disputed gift keeps its pledge links; a chargeback removes them
-- like a refund does (readiness #3).

alter table public.donations drop constraint if exists donations_status_check;
alter table public.donations add constraint donations_status_check check (status = any (array[
  'completed', 'pending', 'post_dated', 'collect', 'voided', 'refunded', 'returned', 'failed', 'rejected', 'disputed', 'chargeback']));
alter table public.donations add column if not exists chargeback_fee numeric(12,2) check (chargeback_fee is null or chargeback_fee >= 0);

-- Campaign balances: a disputed or charged-back gift isn't raised (only completed gifts are), its fee stays spent,
-- and a chargeback fee comes off the balance with the other fees.
do $$
declare v_def text; v_new text; v_opts text;
begin
  v_def := pg_get_viewdef('public.campaign_summary'::regclass);
  v_new := replace(v_def, $s$(dn.status = ANY (ARRAY['completed'::text, 'collect'::text, 'refunded'::text, 'returned'::text])) AS fee_counts$s$,
                          $s$(dn.status = ANY (ARRAY['completed'::text, 'collect'::text, 'refunded'::text, 'returned'::text, 'disputed'::text, 'chargeback'::text])) AS fee_counts$s$);
  if v_new = v_def then raise exception 'campaign_summary: fee statuses not found'; end if;
  v_def := v_new;
  v_new := regexp_replace(v_def, 'dn\.amount,\s*dn\.fee,', 'dn.amount, (COALESCE(dn.fee, (0)::numeric) + COALESCE(dn.chargeback_fee, (0)::numeric)) AS fee,');
  if v_new = v_def then raise exception 'campaign_summary: fee column not found'; end if;
  select coalesce('with (' || array_to_string(reloptions, ', ') || ')', '') into v_opts from pg_class where oid = 'public.campaign_summary'::regclass;
  execute format('create or replace view public.campaign_summary %s as %s', v_opts, v_new);
end $$;

-- A disputed gift keeps its pledge links; a chargeback (or anything else leaving completed) removes them.
create or replace function public.unwind_pledge_payments() returns trigger
language plpgsql security definer set search_path = '' as $function$
declare r record;
begin
  if (old.status in ('completed', 'collect', 'disputed') and new.status not in ('completed', 'collect', 'disputed'))
     or (old.deleted_at is null and new.deleted_at is not null) then
    for r in delete from public.pledge_payments where org_id = new.org_id and donation_id = new.id returning pledge_id, amount loop
      perform public.write_activity(new.org_id, 'pledge_payment_removed', 'pledges', r.pledge_id, new.campaign_id,
        jsonb_build_object('donation', new.id, 'amount', r.amount, 'because', coalesce(case when new.deleted_at is not null then 'deleted' end, new.status)));
    end loop;
  end if;
  return null;
end $function$;

-- Refund by hand: all of it, or part (p_amount). Cards charged through Sola are refunded at Sola instead.
drop function if exists public.refund_donation(text, date, text, text);
create or replace function public.refund_donation(p_id text, p_date date default null, p_method text default null, p_notes text default null,
                                                  p_amount numeric default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  perform public.require_admin();
  if exists (select 1 from public.gateway_transactions g where g.org_id = v_org and g.donation_id = p_id and g.kind = 'sale' and g.status = 'approved')
     and not exists (select 1 from public.gateway_transactions g where g.org_id = v_org and g.donation_id = p_id and g.kind = 'refund'
                     and g.status = 'pending' and g.attempted_at is not null) then
    raise exception 'This payment was charged through Sola. Use Refund at Sola so the money goes back to the card';
  end if;
  if not exists (select 1 from public.donations where org_id = v_org and id = p_id and deleted_at is null and status in ('completed', 'collect')) then
    raise exception 'Only a completed transaction can be refunded';
  end if;
  perform public.refund_part(v_org, p_id, p_amount, coalesce(p_date, public.org_today()), p_notes, p_method);
  update public.donations set reversal_notes = p_notes where org_id = v_org and id = p_id and status = 'refunded' and p_notes is not null;
end $$;
revoke execute on function public.refund_donation(text, date, text, text, numeric) from public, anon;
grant execute on function public.refund_donation(text, date, text, text, numeric) to authenticated;

-- Refund at Sola: all of it, or part (p_amount), up to what's left to refund.
drop function if exists public.begin_card_reversal(text, text);
create or replace function public.begin_card_reversal(p_donation text, p_kind text, p_amount numeric default null) returns uuid
language plpgsql security definer set search_path = '' as $function$
declare v_org uuid := public.current_org_id(); d public.donations; g public.gateway_transactions; v_id uuid; v_left numeric;
begin
  perform public.require_admin();
  if p_kind not in ('void','refund') then raise exception 'Choose void or refund'; end if;
  select * into d from public.donations where org_id = v_org and id = p_donation and deleted_at is null;
  if d.id is null then raise exception 'Transaction not found'; end if;
  if d.status not in ('completed','collect') then raise exception 'Only a completed payment can be voided or refunded'; end if;
  select * into g from public.gateway_transactions
  where org_id = v_org and donation_id = p_donation and kind = 'sale' and status = 'approved' order by created_at desc limit 1;
  if g.id is null then raise exception 'This payment didn''t go through Sola, so mark it refunded instead'; end if;
  if g.method = 'daf' and p_kind = 'refund' then
    raise exception 'A % grant can be voided but not refunded through Sola. Once it can''t be voided, ask % to reverse it', g.daf_program, g.daf_program;
  end if;
  if exists (select 1 from public.gateway_transactions x where x.org_id = v_org and x.donation_id = p_donation and x.kind in ('void','refund')
             and (x.status = 'pending' and x.created_at > now() - interval '2 minutes')) then
    raise exception 'This payment is already being voided or refunded';
  end if;
  select d.amount - coalesce(-sum(r.amount), 0) into v_left from public.donations r
   where r.org_id = v_org and r.refund_of = d.id and r.deleted_at is null and r.status = 'completed';
  if p_kind = 'void' and v_left < d.amount then raise exception 'Part of this payment was refunded, so it can''t be voided. Refund the rest instead'; end if;
  if p_amount is not null and p_kind = 'void' then raise exception 'A void is for the whole payment'; end if;
  if p_amount is not null and (p_amount <= 0 or p_amount > v_left) then
    raise exception 'Enter an amount above $0 and up to the % left to refund', v_left;
  end if;
  insert into public.gateway_transactions (org_id, invoice, kind, amount, campaign_id, donor_id, donation_id, original_ref, card_type, masked_card, method, daf_program)
  values (v_org, public.new_invoice(), p_kind, coalesce(p_amount, v_left), d.campaign_id, d.donor_id, d.id, g.ref_num, g.card_type, g.masked_card, g.method, g.daf_program)
  returning id into v_id;
  return v_id;
end $function$;
revoke execute on function public.begin_card_reversal(text, text, numeric) from public, anon;
grant execute on function public.begin_card_reversal(text, text, numeric) to authenticated;

-- Sola's answer to a refund: the amount it refunded (all or part).
do $$
declare v_def text; v_new text;
begin
  select pg_get_functiondef(p.oid) into v_def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'record_gateway_result';
  v_new := replace(v_def,
    $s$perform public.refund_donation(g.donation_id, public.org_today(), v_method_name, 'Refunded at Sola, ref ' || coalesce(p_result ->> 'xRefNum', ''));$s$,
    $s$perform public.refund_part(p_org, g.donation_id, g.amount, public.org_today(), 'Refunded at Sola, ref ' || coalesce(p_result ->> 'xRefNum', ''), v_method_name);$s$);
  if v_new = v_def then raise exception 'record_gateway_result: refund step not found'; end if;
  execute v_new;
end $$;

-- Disputes and chargebacks.
create or replace function public.mark_disputed(p_id text, p_reason text default null, p_date date default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); d public.donations;
begin
  perform public.require_admin();
  select * into d from public.donations where org_id = v_org and id = p_id and deleted_at is null for update;
  if d.id is null then raise exception 'Transaction not found'; end if;
  if d.status <> 'completed' then raise exception 'Only a completed payment can be disputed'; end if;
  update public.donations set status = 'disputed', reversal_date = coalesce(p_date, public.org_today()),
         reversal_reason = 'Disputed' || coalesce(': ' || nullif(trim(p_reason), ''), '')
   where org_id = v_org and id = p_id;
  insert into public.task_items (org_id, task_key, task_type, record_id, campaign_id, amount, summary)
  values (v_org, 'disputed:' || p_id, 'disputed', p_id, d.campaign_id, d.amount,
          'Disputed ' || coalesce(d.payment_method, 'payment') || ' of $' || to_char(d.amount, 'FM999,999,990.00') || coalesce(' · ' || nullif(trim(p_reason), ''), '') || '. Held out of the balance until it''s settled')
  on conflict (org_id, task_key) do update set resolved_at = null, summary = excluded.summary, amount = excluded.amount;
end $$;

-- Settle a dispute: won puts the gift back; lost is a chargeback, with its fee.
create or replace function public.settle_dispute(p_id text, p_won boolean, p_fee numeric default null, p_notes text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); d public.donations;
begin
  perform public.require_admin();
  select * into d from public.donations where org_id = v_org and id = p_id and deleted_at is null for update;
  if d.id is null then raise exception 'Transaction not found'; end if;
  if d.status <> 'disputed' then raise exception 'This payment isn''t disputed'; end if;
  if p_won then
    update public.donations set status = 'completed', reversal_date = null, reversal_reason = null,
           reversal_notes = 'Dispute won' || coalesce(': ' || nullif(trim(p_notes), ''), '')
     where org_id = v_org and id = p_id;
    update public.task_items set resolved_at = now() where org_id = v_org and task_key = 'disputed:' || p_id and resolved_at is null;
  else
    perform public.record_chargeback(p_id, p_fee, null, coalesce(nullif(trim(p_notes), ''), 'Dispute lost'));
  end if;
end $$;

create or replace function public.record_chargeback(p_id text, p_fee numeric default null, p_date date default null, p_reason text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); d public.donations;
begin
  perform public.require_admin();
  if p_fee is not null and p_fee < 0 then raise exception 'The chargeback fee can''t be below $0'; end if;
  select * into d from public.donations where org_id = v_org and id = p_id and deleted_at is null for update;
  if d.id is null then raise exception 'Transaction not found'; end if;
  if d.status not in ('completed', 'disputed') then raise exception 'Only a completed or disputed payment can be charged back'; end if;
  update public.donations set status = 'chargeback', chargeback_fee = coalesce(p_fee, 0),
         reversal_date = coalesce(p_date, public.org_today()), reversal_reason = 'Chargeback' || coalesce(': ' || nullif(trim(p_reason), ''), '')
   where org_id = v_org and id = p_id;
  update public.task_items set resolved_at = now() where org_id = v_org and task_key = 'disputed:' || p_id and resolved_at is null;
  insert into public.task_items (org_id, task_key, task_type, record_id, campaign_id, amount, summary)
  values (v_org, 'chargeback:' || p_id, 'chargeback', p_id, d.campaign_id, d.amount,
          'Chargeback on $' || to_char(d.amount, 'FM999,999,990.00') || ' (' || coalesce(d.payment_method, 'payment') || ')'
          || case when coalesce(p_fee, 0) > 0 then ', fee $' || to_char(p_fee, 'FM999,990.00') else '' end
          || '. Out of the balance; follow up with the donor if needed')
  on conflict (org_id, task_key) do update set resolved_at = null, summary = excluded.summary, amount = excluded.amount;
end $$;

revoke execute on function public.mark_disputed(text, text, date) from public, anon;
revoke execute on function public.settle_dispute(text, boolean, numeric, text) from public, anon;
revoke execute on function public.record_chargeback(text, numeric, date, text) from public, anon;
grant execute on function public.mark_disputed(text, text, date) to authenticated;
grant execute on function public.settle_dispute(text, boolean, numeric, text) to authenticated;
grant execute on function public.record_chargeback(text, numeric, date, text) to authenticated;


-- The Transactions list's view picks up the new chargeback_fee column (a view's d.* is fixed when it's made).
drop view if exists public.transaction_list;
create view public.transaction_list with (security_invoker = true) as
select d.*,
       c.internal_name as campaign_internal,
       c.external_name as campaign_external,
       coalesce(dn.display_name, nullif(trim(d.donor_label), ''), d.name) as donor_name,
       coalesce(co.full_name, d.collector_label) as collector_name,
       s.name as source_name,
       a.name as account_name,
       (d.status = 'completed' and d.delivered = false and d.payment_method ilike '%check%') is true as undelivered_check,
       (d.status = 'completed' and not coalesce(d.delivered = false and d.payment_method ilike '%check%', false)) as counted,
       case when d.status = 'completed' and not coalesce(d.delivered = false and d.payment_method ilike '%check%', false)
            then case when d.type = 'Payment' then d.amount else coalesce(d.funded, 0) end
            else 0 end as raised
from public.donations d
left join public.campaigns  c  on c.org_id  = d.org_id and c.id  = d.campaign_id
left join public.donors     dn on dn.org_id = d.org_id and dn.id = d.donor_id
left join public.collectors co on co.org_id = d.org_id and co.id = d.collector_id
left join public.sources    s  on s.org_id  = d.org_id and s.id  = d.source
left join public.accounts   a  on a.org_id  = d.org_id and a.id  = d.account_id
where d.deleted_at is null;
revoke all on public.transaction_list from anon;
grant select on public.transaction_list to authenticated;
