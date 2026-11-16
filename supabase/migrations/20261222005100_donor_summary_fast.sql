-- Donors search was slow (Moshe Henig, 2026-11-16: "the donor search takes very long"): about 6 seconds a search.
-- Finding the matching donors took 27 ms; the time went on totals. The view grouped every donation the person can
-- see and joined that to the donors, and with a search the planner re-ran the whole grouping once per matching
-- donor (94 matches for "horowitz" x ~48 ms each). Each donor's totals are now worked out from that donor's own
-- gifts through the donor index (a lateral join), so the cost follows the donors on the page, not all donations.
-- Same columns, same rules, same totals, and it still runs as the person asking (their row security applies).
create or replace view public.donor_summary with (security_invoker = true) as
select dn.id, dn.yiddish_title, dn.yiddish_first_name, dn.yiddish_last_name, dn.yiddish_suffix, dn.english_title,
       dn.first_name, dn.last_name, dn.display_name, dn.yiddish_name, dn.phone, dn.email, dn.address,
       dn.ojc_id, dn.nadvan_id, dn.matbia_id, dn.pledger_id, dn.notes, dn.created_by, dn.created_at, dn.updated_at,
       dn.deleted_at, dn.deleted_by, dn.org_id, dn.country, dn.merged_into,
       g.gift_count,
       coalesce(g.total_given, 0::numeric) as total_given,
       g.first_gift_at,
       g.last_gift_at,
       case when g.gift_count > 0 then g.campaign_count end as campaign_count,
       coalesce(p.open_pledges, 0::numeric) as open_pledges
from public.donors dn
left join lateral (
  select count(*) as gift_count, sum(d.amount) as total_given, min(d.created_at) as first_gift_at,
         max(d.created_at) as last_gift_at, count(distinct d.campaign_id) as campaign_count
  from public.donations d
  where d.org_id = dn.org_id and d.donor_id = dn.id
    and d.status = any (array['completed', 'collect']) and d.deleted_at is null
) g on true
left join lateral (
  select sum(l.balance) as open_pledges
  from public.pledge_list l
  where l.org_id = dn.org_id and l.donor_id = dn.id and l.status = any (array['open', 'partial', 'overdue'])
) p on true
where dn.deleted_at is null;
