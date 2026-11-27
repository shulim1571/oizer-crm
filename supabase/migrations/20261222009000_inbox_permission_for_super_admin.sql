-- The Super Admin has every delegated permission; add "Manage inbox" to the list my_access returns for them.
do $$
declare v_def text; v_new text;
begin
  select pg_get_functiondef('public.my_access'::regproc) into v_def;
  v_new := replace(v_def, $s$"reverse_imports","reopen_campaigns"]$s$, $s$"reverse_imports","reopen_campaigns","manage_inbox"]$s$);
  if v_new = v_def then raise exception 'my_access: permission list not found'; end if;
  execute v_new;
end $$;
