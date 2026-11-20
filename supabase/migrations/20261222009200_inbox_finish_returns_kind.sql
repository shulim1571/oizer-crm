-- email-inbound needs the sender's report type after storing a message, to pick its reader.
-- inbox_finish now answers {status, report_type} instead of just the status.
do $$
declare v_def text; v_new text;
begin
  select pg_get_functiondef('public.inbox_finish(uuid, text, text, text, boolean, text, jsonb, boolean)'::regprocedure) into v_def;
  v_new := replace(v_def, 'RETURNS text', 'RETURNS jsonb');
  v_new := replace(v_new, '  return v_status;', '  return jsonb_build_object(''status'', v_status, ''report_type'', t.report_type);');
  if v_new = v_def or position('jsonb_build_object(''status''' in v_new) = 0 then raise exception 'inbox_finish: not found'; end if;
  drop function public.inbox_finish(uuid, text, text, text, boolean, text, jsonb, boolean);
  execute v_new;
  revoke execute on function public.inbox_finish(uuid, text, text, text, boolean, text, jsonb, boolean) from public, anon, authenticated;
end $$;
