-- Readiness #57 (2026-11-15): the dashboard's payment-method chart showed every spelling imported history used
-- ("Credit Card VISA", "usaepay", "OJC Voucher"...) as its own method, and payouts ("Stripe Payout- AB Charity") as if
-- they were a way of giving. payment_method_aliases maps an imported name to a standard method, or marks it as not a
-- way of giving; the chart groups by it. It starts with a suggested mapping for the names on file, which an admin
-- can change under Fees → Imported names. Only the chart uses it: fees and the "no fee rule" check still go by the
-- gift's own method, so no gift's fee changes.

create table if not exists public.payment_method_aliases (
  id          text not null default public.short_id(),
  org_id      uuid not null default public.current_org_id() references public.organizations(id),
  alias       text not null,
  method_name text,                       -- a standard method's name; empty when it isn't a way of giving
  not_a_method boolean not null default false,
  created_at  timestamptz not null default now(),
  primary key (org_id, id),
  check (not_a_method or nullif(trim(method_name), '') is not null)
);
create unique index if not exists payment_method_aliases_alias on public.payment_method_aliases (org_id, lower(alias));
alter table public.payment_method_aliases enable row level security;
revoke all on public.payment_method_aliases from anon;
grant select, insert, update, delete on public.payment_method_aliases to authenticated;
drop policy if exists org_wall on public.payment_method_aliases;
create policy org_wall on public.payment_method_aliases as restrictive for all to authenticated
  using (org_id = (select public.current_org_id())) with check (org_id = (select public.current_org_id()));
drop policy if exists admin_read on public.payment_method_aliases;
create policy admin_read on public.payment_method_aliases for select to authenticated using ((select public.is_admin()));
drop policy if exists fee_write on public.payment_method_aliases;
create policy fee_write on public.payment_method_aliases for all to authenticated
  using ((select public.has_super_permission('configure_fees'))) with check ((select public.has_super_permission('configure_fees')));

-- The method a gift is shown under: its alias's method, else its own.
create or replace function public.method_group(p_org uuid, p_method text) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select case when a.not_a_method then 'Not a way of giving' else a.method_name end
       from public.payment_method_aliases a where a.org_id = p_org and lower(a.alias) = lower(trim(p_method))),
    nullif(trim(p_method), ''), 'Not recorded')
$$;
revoke execute on function public.method_group(uuid, text) from public, anon;
grant execute on function public.method_group(uuid, text) to authenticated;

-- The dashboard's chart groups by it.
do $$
declare v_def text; v_new text;
begin
  select pg_get_functiondef(p.oid) into v_def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'dashboard_stats';
  v_new := replace(v_def, $s$select coalesce(nullif(trim(r.payment_method), ''), 'Not recorded') as name, sum(r.raised) as total, count(*) as n$s$,
                          $s$select public.method_group(v_org, r.payment_method) as name, sum(r.raised) as total, count(*) as n$s$);
  if v_new = v_def then raise exception 'dashboard_stats: methods not found'; end if;
  execute v_new;
end $$;

-- A suggested mapping for the names imported history used (each org can change it). Only names actually on file,
-- and only where the standard method exists.
insert into public.payment_method_aliases (org_id, alias, method_name, not_a_method)
select d.org_id, d.alias, m.name, false
from (select distinct org_id, trim(payment_method) as alias from public.donations where payment_method is not null) d
join (values
  ('usaepay', 'Credit Card'), ('credit card visa', 'Credit Card'), ('credit card mastercard', 'Credit Card'), ('credit card amex', 'Credit Card'),
  ('credit card discover', 'Credit Card'), ('visa', 'Credit Card'), ('mastercard', 'Credit Card'), ('amex', 'Credit Card'), ('discover', 'Credit Card'),
  ('ojc voucher', 'Voucher — OJC Fund'), ('ojc voucher manual', 'Voucher — OJC Fund'), ('pledger voucher', 'Voucher — Pledger'),
  ('donors fund voucher', 'Voucher — Donors Fund'), ('donors_fund', 'Donors Fund'), ('donorsfund', 'Donors Fund'), ('donors fund discover', 'Donors Fund'),
  ('matbia visa', 'Matbia'), ('matbia token', 'Matbia'), ('matbia tokens', 'Matbia'), ('matbia diners', 'Matbia'),
  ('pledger pledger', 'Pledger'), ('pledger discover', 'Pledger'), ('zeffy.com', 'Zeffy'), ('fidelty daf', 'Fidelity DAF'),
  ('pay pal giving fund', 'PayPal Giving Fund')
) as s(alias_lower, target) on lower(d.alias) = s.alias_lower
join public.payment_methods m on m.org_id = d.org_id and lower(m.name) = lower(s.target)
on conflict do nothing;

insert into public.payment_method_aliases (org_id, alias, method_name, not_a_method)
select distinct d.org_id, trim(d.payment_method), null::text, true
from public.donations d
where lower(trim(d.payment_method)) in ('stripe payout- ab charity', 'daf payout- ab charity', 'daf cards on ab charity')
on conflict do nothing;
