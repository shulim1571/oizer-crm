-- A campaign's statement (Shulim, 2026-11-25): every movement of its money in date order, like a bank statement, with
-- the campaign balance after each one. The same rules as the campaign balance (campaign_summary), entry by entry:
--   * a gift adds what it raised (a counted gift: completed, and not a check marked not delivered; a Batch deposit
--     adds its funded part) and takes off its fee (and any chargeback fee) whenever the balance counts that fee
--     (completed, to collect, refunded, returned, disputed, chargeback; not an undelivered check);
--   * a payout takes off its amount; a transfer in adds, a transfer out takes off.
-- Gifts that move nothing (pending approval, post-dated, held Donary cash/checks, voided, failed) aren't listed.
-- Teams and sub-campaigns that share the campaign's balance are included, so the last line is the balance shown on
-- the campaign. Staff only: admins, and fundraisers for their own campaigns (payee details only for those who may
-- see them, as on the Payouts tab). Read-only.

create or replace function public.campaign_statement(p_campaign text)
returns table (kind text, id text, campaign_id text, at timestamptz, description text,
               money_in numeric, fee numeric, money_out numeric, change numeric, balance numeric)
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_detail boolean;
begin
  if v_org is null or not (public.is_admin() or p_campaign = any(public.my_campaign_ids())) then
    raise exception 'That campaign isn''t yours';
  end if;
  v_detail := public.is_admin() or public.can_see_payout_detail(p_campaign);
  return query
  with recursive fam as (
    select c.id from public.campaigns c where c.org_id = v_org and c.id = p_campaign and c.deleted_at is null
    union
    select s.id from public.campaigns s join fam f on s.parent_campaign_id = f.id
    where s.org_id = v_org and s.balance_mode = 'shared' and s.deleted_at is null
  ),
  g as (
    select d.id, d.campaign_id, d.created_at, d.type,
           coalesce(dn.display_name, nullif(trim(d.donor_label), ''), d.name) as donor,
           ((d.status = 'completed' and d.delivered = false and d.payment_method ilike '%check%') is true) as und,
           (d.status = 'completed' and not coalesce(d.delivered = false and d.payment_method ilike '%check%', false)) as counted,
           (d.status = any (array['completed', 'collect', 'refunded', 'returned', 'disputed', 'chargeback'])) as fee_counts,
           case when d.type = 'Payment' then d.amount else coalesce(d.funded, 0) end as raised_part,
           coalesce(d.fee, 0) + coalesce(d.chargeback_fee, 0) as all_fees,
           d.status
    from public.donations d
    left join public.donors dn on dn.org_id = d.org_id and dn.id = d.donor_id
    where d.org_id = v_org and d.deleted_at is null and d.campaign_id in (select f.id from fam f)
  ),
  moves as (
    select 'donation'::text as kind, g.id, g.campaign_id, g.created_at as at,
           concat_ws(' · ', case when g.type = 'Batch' then 'Batch deposit' else coalesce(g.donor, 'Gift') end,
                     case when g.status <> 'completed' then initcap(replace(g.status, '_', ' ')) end) as description,
           case when g.counted then g.raised_part else 0 end as money_in,
           case when g.fee_counts and not g.und then g.all_fees else 0 end as fee,
           0::numeric as money_out
    from g where g.counted or (g.fee_counts and not g.und)
    union all
    select 'payout', e.id, e.campaign_id, e.created_at,
           case when v_detail then coalesce(nullif(trim(e.payee), ''), 'Payout') else 'Payout' end, 0, 0, e.amount
    from public.expenses e
    where e.org_id = v_org and e.deleted_at is null and e.campaign_id in (select f.id from fam f)
    union all
    select 'transfer_in', t.id, t.to_campaign_id, t.created_at,
           'Transfer from ' || coalesce(t.from_campaign_id, 'outside'), t.amount, 0, 0
    from public.transfers t
    where t.org_id = v_org and t.deleted_at is null and t.to_campaign_id in (select f.id from fam f)
    union all
    select 'transfer_out', t.id, t.from_campaign_id, t.created_at,
           'Transfer to ' || coalesce(t.to_campaign_id, 'outside'), 0, 0, t.amount
    from public.transfers t
    where t.org_id = v_org and t.deleted_at is null and t.from_campaign_id in (select f.id from fam f)
  )
  select m.kind, m.id, m.campaign_id, m.at, m.description, m.money_in, m.fee, m.money_out,
         m.money_in - m.fee - m.money_out,
         sum(m.money_in - m.fee - m.money_out) over (order by m.at, m.kind, m.id rows between unbounded preceding and current row)
  from moves m
  order by m.at, m.kind, m.id;
end $$;
revoke execute on function public.campaign_statement(text) from public, anon;
grant execute on function public.campaign_statement(text) to authenticated;
