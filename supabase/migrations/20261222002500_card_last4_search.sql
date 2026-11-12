-- Search transactions by the card's last 4 digits (Moshe Henig, 2026-11-12). The digits are known for card payments
-- taken through Sola (gateway_transactions.masked_card, e.g. 4xxxxxxxxxxx1111); imported transactions don't carry
-- them. Runs as the person asking (security invoker), so only admins, who can read card details, get answers, and
-- only for their own organization.
create or replace function public.transactions_by_card_last4(p_last4 text) returns text[]
language sql stable security invoker set search_path = '' as $$
  select coalesce(array_agg(distinct g.donation_id), '{}')
  from public.gateway_transactions g
  where p_last4 ~ '^[0-9]{4}$' and g.donation_id is not null and right(g.masked_card, 4) = p_last4
$$;
revoke execute on function public.transactions_by_card_last4(text) from public, anon;
grant execute on function public.transactions_by_card_last4(text) to authenticated;
