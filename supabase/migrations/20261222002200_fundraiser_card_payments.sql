-- Fundraisers take card payments from New Donation (Moshe Henig, 2026-11-12: "users with the fundraiser role should
-- also have a New Donation button ... the only payment method allowed is card payment").
-- Kept narrow, and checked here rather than only in the screen:
--   * an active fundraiser (manager role), on a campaign they work on (primary or secondary; not as a guest);
--   * a card typed in now: never a donor's saved card, nothing saved, no bank (ACH) or fund (DAF) payments, no
--     recurring schedule;
--   * the same Sola checks and limits as the office's own card charges; the attempt records who asked
--     (gateway_transactions.requested_by) and the approved charge becomes a completed donation as usual.
-- Manual payments are unchanged: a fundraiser with the "enter manual payments" permission enters them, held until
-- an admin approves, exactly as on the campaign page.
create or replace function public.begin_fundraiser_card_sale(
  p_campaign text, p_amount numeric, p_name text default null, p_email text default null, p_notes text default null, p_ip text default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_status text; v_id uuid;
begin
  if v_org is null or public.my_org_role() is distinct from 'manager' then
    raise exception 'Only a fundraiser can take a card payment here';
  end if;
  if p_campaign is null or not (p_campaign = any(coalesce(public.my_campaign_ids(), '{}'))) then
    raise exception 'You can take card payments only for your own campaigns';
  end if;
  if not exists (select 1 from public.payment_settings s where s.org_id = v_org and s.api_key is not null and s.ifields_key is not null) then
    raise exception 'Card payments aren''t set up yet. Ask the office to add the Sola keys under Settings → Payments';
  end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'Enter an amount'; end if;
  if p_amount > 100000 then raise exception 'Charge up to $100,000 at a time'; end if;
  select c.status into v_status from public.campaigns c where c.org_id = v_org and c.id = p_campaign and c.deleted_at is null;
  if v_status is null then raise exception 'Choose a campaign'; end if;
  if v_status = 'closed' then raise exception 'Campaign % is closed', p_campaign; end if;
  insert into public.gateway_transactions (org_id, invoice, kind, amount, campaign_id, donor_id, card_id, save_card, card_name, email, notes, ip, method)
  values (v_org, public.new_invoice(), 'sale', round(p_amount, 2), p_campaign, null, null, false,
          nullif(trim(p_name), ''), nullif(trim(p_email), ''), nullif(trim(p_notes), ''), p_ip, 'card')
  returning id into v_id;
  return v_id;
end $$;

-- What the fundraiser's card form needs: Sola's browser (iFields) key, which is meant to be public, and whether card
-- payments are set up. Nothing else from the payment settings.
create or replace function public.fundraiser_payment_config()
returns table (ifields_key text, sandbox boolean, api_key_set boolean)
language sql stable security definer set search_path = '' as $$
  select s.ifields_key, s.sandbox, s.api_key is not null
  from public.payment_settings s
  where s.org_id = public.current_org_id() and public.my_org_role() = 'manager'
    and cardinality(coalesce(public.my_campaign_ids(), '{}')) > 0
$$;

revoke execute on function public.begin_fundraiser_card_sale(text, numeric, text, text, text, text) from public, anon;
grant execute on function public.begin_fundraiser_card_sale(text, numeric, text, text, text, text) to authenticated;
revoke execute on function public.fundraiser_payment_config() from public, anon;
grant execute on function public.fundraiser_payment_config() to authenticated;
