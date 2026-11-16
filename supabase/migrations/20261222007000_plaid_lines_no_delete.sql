-- Readiness #33 (2026-11-15): a bank line that came from the bank's own feed (Plaid) is the bank's record, so it can't
-- be deleted; one that doesn't belong to the books is set aside with a reason instead (recorded as a bank-only match,
-- "Other", with the reason as its note). Lines brought in from a file or typed in can still be deleted.
do $$
declare v_def text; v_new text;
begin
  select pg_get_functiondef(p.oid) into v_def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'delete_bank_line';
  v_new := replace(v_def, $s$  if l.match_id is not null then raise exception 'Unmatch this line first'; end if;$s$,
    $s$  if l.match_id is not null then raise exception 'Unmatch this line first'; end if;
  if l.source = 'plaid' then raise exception 'This line came from the bank feed, so it can''t be deleted. Set it aside with a reason instead'; end if;$s$);
  if v_new = v_def then raise exception 'delete_bank_line: match check not found'; end if;
  execute v_new;
end $$;
