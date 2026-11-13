-- Payment page retries can't charge twice, and a lost reply still ends in the thank-you (Moshe Henig, 2026-11-11: "it
-- said something went wrong, but in the app it did come in as a successful donation"; his retry was charged again).
-- The page sends a one-time key with each gift and keeps it across retries. If an attempt with that key was already
-- approved, the payment function answers with that result instead of charging again; if it's still in progress, it
-- says so. When the reply to the page is lost, the page asks for the attempt's outcome by the same key.

alter table public.gateway_transactions add column if not exists client_key text;
create index if not exists gateway_transactions_client_key on public.gateway_transactions (org_id, client_key) where client_key is not null;

create or replace function public.public_payment_attempt(p_org uuid, p_key text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('status', t.status, 'kind', t.kind, 'amount', t.amount, 'method', t.method, 'ref', t.ref_num,
           'card_type', t.card_type, 'masked_card', t.masked_card, 'daf_program', t.daf_program, 'recurring_plan', t.recurring_plan,
           'recurring_id', t.recurring_id, 'token', t.public_token, 'error', t.error)
  from public.gateway_transactions t
  where t.org_id = p_org and t.client_key = p_key and p_key ~ '^[A-Za-z0-9-]{16,64}$'
  order by t.created_at desc limit 1
$$;

create or replace function public.tag_payment_attempt(p_org uuid, p_id uuid, p_key text) returns void
language sql security definer set search_path = '' as $$
  update public.gateway_transactions set client_key = p_key
  where org_id = p_org and id = p_id and p_key ~ '^[A-Za-z0-9-]{16,64}$';
$$;

revoke execute on function public.public_payment_attempt(uuid, text) from public, anon, authenticated;
revoke execute on function public.tag_payment_attempt(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.public_payment_attempt(uuid, text), public.tag_payment_attempt(uuid, uuid, text) to service_role;
