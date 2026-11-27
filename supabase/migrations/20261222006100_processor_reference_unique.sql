-- Readiness #23 (2026-11-15): nothing stopped the same processor transaction being recorded twice; the feeds only
-- looked first, so two deliveries at once could both get in.
--
-- * One live gift per processor reference: unique (organization, gateway reference) and (organization, Donary payment
--   number), for gifts that count (not deleted, not failed). Split parts share their gift's reference, and a partial
--   refund's own row points at its gift, so those are left out of the rule. So is imported history (ids starting
--   AS-): its Donary field isn't a payment number (one value covers several different gifts, e.g. 69091 on nine), and
--   its references were never checked. Gifts from the feeds and the app have no duplicates (checked on live data).
-- * A delivery that hits the rule is answered and logged as a duplicate, not an error.
-- * The 15 pairs of imported gifts sharing a gateway reference (same amount, day and machine) are flagged as
--   possible duplicates for an admin to review under Transactions → Possible duplicates. Nothing is deleted.

create unique index if not exists donations_gateway_once on public.donations (org_id, gateway_id)
  where gateway_id is not null and deleted_at is null and status <> 'failed' and split_group_id is null and refund_of is null and id not like 'AS-%';
create unique index if not exists donations_donary_once on public.donations (org_id, donary_id)
  where donary_id is not null and deleted_at is null and status <> 'failed' and split_group_id is null and refund_of is null and id not like 'AS-%';

do $$
declare v_def text; v_new text;
begin
  select pg_get_functiondef(p.oid) into v_def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'make_ingest';
  v_new := replace(v_def, '  exception when others then
    -- The reason only', '  exception
  when unique_violation then
    -- Recorded already (two deliveries of one transaction at once): a duplicate, not an error.
    insert into public.make_ingest_log (org_id, source, outcome, message) values (p_org, p_source, ''duplicate'', ''Already recorded (same processor reference)'');
    return jsonb_build_object(''ok'', true, ''status'', 200, ''outcome'', ''duplicate'', ''message'', ''Already recorded (same processor reference)'');
  when others then
    -- The reason only');
  if v_new = v_def then raise exception 'make_ingest: error handler not found'; end if;
  execute v_new;
end $$;

-- Flag the imported pairs for review (no balance changes).
update public.donations d set possible_duplicate = true
 where d.id like 'AS-%' and d.deleted_at is null and d.status <> 'failed' and d.split_group_id is null and d.refund_of is null
   and d.gateway_id is not null and not coalesce(d.possible_duplicate, false)
   and exists (select 1 from public.donations o
               where o.org_id = d.org_id and o.gateway_id = d.gateway_id and o.id <> d.id and o.deleted_at is null
                 and o.status <> 'failed' and o.split_group_id is null and o.refund_of is null);
