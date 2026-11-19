-- The Transactions "Card last 4" search also finds gifts whose card last 4 came from a feed or a deposit report
-- (donations.card_last4), not only cards charged through Donor Base's own Sola payments.
create or replace function public.transactions_by_card_last4(p_last4 text) returns text[]
language sql stable security definer set search_path = '' as $function$
  select coalesce(array_agg(distinct x.id), '{}') from (
    select g.donation_id as id from public.gateway_transactions g
     where p_last4 ~ '^[0-9]{4}$' and g.donation_id is not null and right(g.masked_card, 4) = p_last4
       and g.org_id = public.current_org_id()
    union
    select d.id from public.donations d
     where p_last4 ~ '^[0-9]{4}$' and d.org_id = public.current_org_id() and d.card_last4 = p_last4 and d.deleted_at is null
  ) x
$function$;
