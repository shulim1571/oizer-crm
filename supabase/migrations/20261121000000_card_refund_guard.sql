-- A payment charged through Sola is refunded through Sola, so the money really goes back to the card.
-- Marking it refunded in the CRM alone left the card charged. refund_donation now refuses those, except
-- while the payments function is recording Sola's own approved refund.

create or replace function public.refund_donation(p_id text, p_date date default null, p_method text default null, p_notes text default null) returns void
language plpgsql set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  perform public.require_admin();
  if exists (select 1 from public.gateway_transactions g where g.org_id = v_org and g.donation_id = p_id and g.kind = 'sale' and g.status = 'approved')
     and not exists (select 1 from public.gateway_transactions g where g.org_id = v_org and g.donation_id = p_id and g.kind = 'refund'
                     and g.status = 'pending' and g.attempted_at is not null) then
    raise exception 'This payment was charged through Sola. Use Refund at Sola so the money goes back to the card';
  end if;
  update public.donations
  set status = 'refunded', reversal_date = coalesce(p_date, current_date), reversal_method = p_method, reversal_notes = p_notes
  where id = p_id and org_id = v_org and status in ('completed','collect');
  if not found then raise exception 'Only a completed transaction can be refunded'; end if;
end $$;
