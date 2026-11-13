-- "Editing a campaign so far didn't change the wording on the payment page" (Moshe Henig, 2026-11-11). Team 1012A was
-- renamed to "Schwartz Shoes 1", but its page still showed "Schwartsz Shoes": the external name was the copy made when
-- it was created (before campaign_name_follows), and it had stopped matching after an earlier rename, so it no longer
-- looked like a copy. A campaign whose external name was only ever that creation copy (equal to the internal name at
-- creation, never edited on its own since) now uses its current internal name again. External names set on purpose
-- (like 1010's) are left alone.
update public.campaigns c set external_name = c.internal_name
from (
  select distinct on (a.org_id, a.record_id) a.org_id, a.record_id, a.changes->>'external_name' as ext, a.changes->>'internal_name' as int
  from public.activity_log a
  where a.table_name = 'campaigns' and a.action = 'insert'
  order by a.org_id, a.record_id, a.created_at
) ins
where ins.org_id = c.org_id and ins.record_id = c.id
  and ins.ext = ins.int and c.external_name = ins.ext and c.external_name is distinct from c.internal_name
  and not exists (select 1 from public.activity_log u where u.org_id = c.org_id and u.table_name = 'campaigns' and u.record_id = c.id
                    and u.action = 'update' and u.changes ? 'external_name');
