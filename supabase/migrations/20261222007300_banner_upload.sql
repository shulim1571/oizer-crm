-- Readiness #55 (2026-11-15): a campaign's banner can be an uploaded picture (shrunk and stored with the page, as the
-- organization's logo already is), as well as an https:// address. Uploaded pictures are limited to about 700 KB.
do $$
declare v_def text; v_new text;
begin
  select pg_get_functiondef(p.oid) into v_def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'save_page_content';
  v_new := replace(v_def,
    $s$  if nullif(trim(p_banner_url), '') is not null and trim(p_banner_url) !~ '^https://' then raise exception 'The banner must be an https:// address'; end if;$s$,
    $s$  if nullif(trim(p_banner_url), '') is not null and trim(p_banner_url) !~ '^https://' and trim(p_banner_url) !~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$' then
    raise exception 'The banner must be an https:// address or an uploaded picture';
  end if;
  if length(coalesce(p_banner_url, '')) > 700000 then raise exception 'That banner picture is too large; try a smaller one'; end if;$s$);
  if v_new = v_def then raise exception 'save_page_content: banner check not found'; end if;
  execute v_new;
end $$;
