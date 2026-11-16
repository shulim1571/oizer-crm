-- Readiness #26 follow-up: the raised tie-out compared a parent campaign's own raised figure with its gifts plus its
-- shared teams' gifts, so a parent whose teams had gifts showed as off by exactly those (1008: $152, 1012: $150).
-- Each campaign, teams included, is now compared with its own gifts.
do $$
declare v_def text; v_new text;
begin
  select pg_get_functiondef(p.oid) into v_def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'integrity_checks';
  v_new := replace(v_def, 'and (c.id = s.id or (c.balance_mode = ''shared'' and c.parent_campaign_id = s.id))) r on true', 'and c.id = s.id) r on true');
  v_new := replace(v_new, 'where s.org_id = p_org and s.pool_id is null) x
   where abs(x.diff) >= 0.01', 'where s.org_id = p_org) x
   where abs(x.diff) >= 0.01');
  if v_new = v_def or position('and c.id = s.id) r on true' in v_new) = 0 or position('where s.org_id = p_org) x' in v_new) = 0 then
    raise exception 'integrity_checks: tie-out not found';
  end if;
  execute v_new;
end $$;
