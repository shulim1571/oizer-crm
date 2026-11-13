-- The recurring list named its campaign through campaign_label, which signed-in users may not call (it takes
-- any organization's id). It now reads the campaign directly, under the reader's own row-level security.
create or replace view public.recurring_list with (security_invoker = true) as
select x.*, coalesce(dn.display_name, '') as donor_name,
       coalesce(c.internal_name, c.external_name, c.campaign_name, x.campaign_id) || ' (' || x.campaign_id || ')' as campaign_label,
       k.masked as card_masked, k.card_type, k.exp as card_exp,
       case when x.status = 'active' and x.next_charge is not null then
         (select count(*) from generate_series(0, coalesce(x.total_payments - x.payments_made - 1, 400)) n
          where public.recurring_date(x.next_charge, x.frequency, n) <= current_date + 30) end as due_30,
       case when x.status = 'active' and x.next_charge is not null then
         (select count(*) from generate_series(0, coalesce(x.total_payments - x.payments_made - 1, 400)) n
          where public.recurring_date(x.next_charge, x.frequency, n) <= current_date + 90) end as due_90,
       case when x.total_payments is not null then public.recurring_date(x.start_date, x.frequency, x.total_payments - 1) end as final_charge
from public.recurring_donations x
left join public.donors dn on dn.org_id = x.org_id and dn.id = x.donor_id
left join public.campaigns c on c.org_id = x.org_id and c.id = x.campaign_id
left join lateral public.recurring_card(x.org_id, x.card_id) k on true;
