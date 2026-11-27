-- Readiness #22 (2026-11-15): splitting a gift across campaigns dropped its references from the new parts.
--
-- * Every part now carries the gift's references: processor reference (gateway_id, donary_id), deposit batch,
--   bank reference, voucher, who entered it, and the check's delivery and date details. A voucher's funded total no
--   longer drops when a voucher funding is split.
-- * Bank reconciliation sees a split gift as the one deposit it was: one book item ("donation_split", the parts
--   added up), unless a part was already matched or set aside on its own (those keep showing part by part).
-- * A processor void or refund (Make) for a split gift reverses every part, not just the one it found first.

-- Splits copy every reference onto every part.
do $$
declare v_def text; v_new text;
begin
  select pg_get_functiondef(p.oid) into v_def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'split_donation';
  v_new := replace(v_def,
    'source, payment_method, name, phone, email, notes, account_id, split_group_id, created_at, anonymous, check_number)',
    'source, payment_method, name, phone, email, notes, account_id, split_group_id, created_at, anonymous, check_number,
                                    gateway_id, donary_id, batch_id, bank_reference, voucher_id, created_by, delivered, check_date, post_dated)');
  v_new := replace(v_new,
    'd.source, d.payment_method, d.name, d.phone, d.email, d.notes, d.account_id, v_group, d.created_at, d.anonymous, d.check_number);',
    'd.source, d.payment_method, d.name, d.phone, d.email, d.notes, d.account_id, v_group, d.created_at, d.anonymous, d.check_number,
              d.gateway_id, d.donary_id, d.batch_id, d.bank_reference, d.voucher_id, d.created_by, d.delivered, d.check_date, d.post_dated);');
  if position('d.gateway_id, d.donary_id, d.batch_id' in v_new) = 0 or position('gateway_id, donary_id, batch_id, bank_reference' in v_new) = 0 then
    raise exception 'split_donation: insert not found';
  end if;
  execute v_new;
end $$;

-- Processor void: every part of a split gift.
create or replace function public.make_void(p_org uuid, p_payment text, p_gateway text, p_why text) returns text
language plpgsql security definer set search_path = '' as $$
declare v_id text := public.make_existing(p_org, p_payment, p_gateway); v_group text;
begin
  if v_id is null then return null; end if;
  select split_group_id into v_group from public.donations where org_id = p_org and id = v_id;
  update public.donations set status = 'voided', reversal_date = public.org_date(p_org), reversal_reason = p_why
  where org_id = p_org and status <> 'voided' and deleted_at is null
    and (id = v_id or (v_group is not null and split_group_id = v_group));
  return v_id;
end $$;

-- Processor refund: all of a split gift refunds every part; part of it comes off the part the processor's
-- reference found (as for any gift, up to what that part has left).
create or replace function public.make_refund(p_org uuid, p_payment text, p_gateway text, p_amount numeric, p_when text, p_why text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_id text := public.make_existing(p_org, p_payment, p_gateway); v_group text; v_total numeric; r record;
begin
  if v_id is null then return null; end if;
  select split_group_id into v_group from public.donations where org_id = p_org and id = v_id;
  if v_group is not null then
    select sum(amount) into v_total from public.donations
     where org_id = p_org and split_group_id = v_group and deleted_at is null and status in ('completed', 'collect');
    if p_amount is null or p_amount >= coalesce(v_total, 0) then
      for r in select id from public.donations where org_id = p_org and split_group_id = v_group and deleted_at is null
                 and status in ('completed', 'collect') loop
        perform public.refund_part(p_org, r.id, null, public.org_date(p_org, p_when), p_why, 'Processor refund');
      end loop;
      return v_id;
    end if;
  end if;
  return public.refund_part(p_org, v_id, p_amount, public.org_date(p_org, p_when), p_why, 'Processor refund');
end $$;

-- Reconciliation: a split gift is one book item.
alter table public.recon_match_items drop constraint if exists recon_match_items_item_type_check;
alter table public.recon_match_items add constraint recon_match_items_item_type_check
  check (item_type in ('donation', 'donation_split', 'donation_reversal', 'payout', 'bank_transfer_out', 'bank_transfer_in'));
alter table public.recon_exclusions drop constraint if exists recon_exclusions_item_type_check;
alter table public.recon_exclusions add constraint recon_exclusions_item_type_check
  check (item_type in ('donation', 'donation_split', 'donation_reversal', 'payout', 'bank_transfer_out', 'bank_transfer_in'));

do $$
declare v_def text; v_new text;
begin
  select pg_get_functiondef(p.oid) into v_def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'exclude_book_item';
  v_new := replace(v_def, $s$if p_type not in ('donation','donation_reversal','payout','bank_transfer_out','bank_transfer_in') then$s$,
                          $s$if p_type not in ('donation','donation_split','donation_reversal','payout','bank_transfer_out','bank_transfer_in') then$s$);
  v_new := replace(v_new, $s$(p_type in ('donation','donation_reversal') and exists (select 1 from public.donations d where d.org_id = v_org and d.id = p_id))$s$,
                          $s$(p_type in ('donation','donation_reversal') and exists (select 1 from public.donations d where d.org_id = v_org and d.id = p_id))
    or (p_type = 'donation_split' and exists (select 1 from public.donations d where d.org_id = v_org and d.split_group_id = p_id))$s$);
  if position('donation_split' in v_new) = 0 or position('d.split_group_id = p_id' in v_new) = 0 then
    raise exception 'exclude_book_item: type check not found';
  end if;
  execute v_new;
end $$;

create or replace function public.recon_book_items(p_org uuid, p_account text)
returns table (item_type text, item_id text, item_date date, amount numeric, fee numeric, payment_method text, description text,
               check_number text, campaign_id text, match_id text, excluded boolean, exclude_reason text)
language sql stable security definer set search_path = '' as $function$
  with dons as (
    select d.*,
           -- A split gift shows as one item unless one of its parts was matched or set aside on its own.
           d.split_group_id is not null and not exists (
             select 1 from public.donations p
             where p.org_id = d.org_id and p.split_group_id = d.split_group_id
               and (exists (select 1 from public.recon_match_items m where m.org_id = p.org_id and m.item_type = 'donation' and m.item_id = p.id)
                    or exists (select 1 from public.recon_exclusions x where x.org_id = p.org_id and x.item_type = 'donation' and x.item_id = p.id))
           ) as as_group
    from public.donations d
    where d.org_id = p_org and d.account_id = p_account and d.deleted_at is null and d.amount <> 0
      and d.status in ('completed','collect','refunded','returned')
  ), items as (
    select 'donation'::text as item_type, d.id as item_id,
           coalesce(case when d.post_dated then d.check_date end, public.org_date(d.created_at)) as item_date,
           d.amount, coalesce(d.fee, 0) as fee, d.payment_method,
           concat_ws(' · ', coalesce(d.payment_method, 'Payment'), nullif(coalesce(nullif(d.name, ''), d.donor_label), '')) as description,
           d.check_number, d.campaign_id
    from dons d where not d.as_group
    union all
    select 'donation_split', d.split_group_id,
           min(coalesce(case when d.post_dated then d.check_date end, public.org_date(d.created_at))),
           sum(d.amount), sum(coalesce(d.fee, 0)), min(d.payment_method),
           concat_ws(' · ', coalesce(min(d.payment_method), 'Payment'), nullif(min(coalesce(nullif(d.name, ''), d.donor_label)), ''),
                     'split across ' || count(*) || ' campaigns'),
           min(d.check_number), null
    from dons d where d.as_group
    group by d.split_group_id
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
$function$;

-- "Available to pay out" (readiness #19): a check in a split gift counts as cleared once the split is matched.
do $$
declare v_def text; v_new text;
begin
  select pg_get_functiondef(p.oid) into v_def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'campaign_available';
  v_new := replace(v_def,
    $s$and not exists (select 1 from public.recon_match_items mi where mi.org_id = g.org_id and mi.item_type = 'donation' and mi.item_id = g.id)$s$,
    $s$and not exists (select 1 from public.recon_match_items mi where mi.org_id = g.org_id
                                and ((mi.item_type = 'donation' and mi.item_id = g.id) or (mi.item_type = 'donation_split' and mi.item_id = g.split_group_id)))$s$);
  if v_new = v_def then raise exception 'campaign_available: cleared check not found'; end if;
  execute v_new;
end $$;
