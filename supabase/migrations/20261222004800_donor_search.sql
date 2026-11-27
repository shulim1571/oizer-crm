-- Donors search (Moshe Henig, 2026-11-15): searching a last name showed only part of the matches (the lookup stopped
-- at 20) with no way to see more, and the whole donor list still showed underneath. The Donors list now searches
-- itself on the server, page by page, through donor_summary (each person sees exactly the donors they see today).

-- Donors whose phone has these digits, whatever its formatting: "7185550100" finds "(718) 555-0100".
-- Security invoker: the caller's own row security decides which donors it can find.
create or replace function public.donor_ids_by_phone(p_digits text) returns setof text
language sql stable security invoker set search_path = '' as $$
  select d.id from public.donors d
  where length(regexp_replace(coalesce(p_digits, ''), '\D', '', 'g')) >= 4
    and d.deleted_at is null
    and regexp_replace(coalesce(d.phone, ''), '\D', '', 'g') like '%' || regexp_replace(p_digits, '\D', '', 'g') || '%'
$$;
revoke execute on function public.donor_ids_by_phone(text) from public, anon;
grant execute on function public.donor_ids_by_phone(text) to authenticated;

-- The organization-wide lookup fundraisers use to add a donor to their list: now paged (no hidden 21st match),
-- every word must match (so "Moshe Horowitz" and "Horowitz Moshe" both work), and it can leave out donors
-- already on the caller's list (they are in the Donors list itself). It returns the same fields as before.
drop function if exists public.lookup_donors(text);
create or replace function public.lookup_donors(p_q text, p_limit int default 20, p_offset int default 0, p_not_mine boolean default false)
returns table (id text, display_name text, yiddish_name text, phone text, email text, on_my_list boolean, total_count bigint)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  v_q text := trim(coalesce(p_q, ''));
  v_words text[];
  v_digits text := regexp_replace(v_q, '\D', '', 'g');
  v_admin boolean := public.is_admin();
begin
  if not v_admin and coalesce(array_length(public.my_manager_ids(), 1), 0) = 0 then
    raise exception 'Only admins and fundraisers can look up donors';
  end if;
  if length(v_q) < 2 then return; end if;
  v_words := regexp_split_to_array(v_q, '\s+');
  return query
    with m as (
      select d.id, d.display_name, d.yiddish_name, d.phone, d.email,
             v_admin
             or exists (select 1 from public.fundraiser_donors f where f.org_id = v_org and f.donor_id = d.id and f.manager_id = any(public.my_manager_ids()))
             or exists (select 1 from public.donations x where x.org_id = v_org and x.donor_id = d.id and x.deleted_at is null and x.campaign_id = any(public.my_campaign_ids())) as mine
      from public.donors d
      where d.org_id = v_org and d.deleted_at is null
        and (d.id = v_q
             or (length(v_digits) >= 4 and regexp_replace(coalesce(d.phone, ''), '\D', '', 'g') like '%' || v_digits || '%')
             or not exists (select 1 from unnest(v_words) w
                            where not (coalesce(d.display_name, '') ilike '%' || w || '%' or coalesce(d.yiddish_name, '') ilike '%' || w || '%'
                                       or coalesce(d.email, '') ilike '%' || w || '%')))
    )
    select m.id, m.display_name, m.yiddish_name, m.phone, m.email, m.mine, count(*) over ()
    from m
    where not (p_not_mine and m.mine)
    order by m.display_name, m.id
    limit greatest(least(coalesce(p_limit, 20), 200), 1) offset greatest(coalesce(p_offset, 0), 0);
end $$;
revoke execute on function public.lookup_donors(text, int, int, boolean) from public, anon;
grant execute on function public.lookup_donors(text, int, int, boolean) to authenticated;
