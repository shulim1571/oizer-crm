-- Check and receipt files (check signature, director's signature, MICR font) come back as hex instead of base64
-- (Moshe Henig, 2026-11-11: printing a check failed with "the signature file came back damaged (an unexpected '='
-- at character 95 of 11988)").
--
-- The stored files were checked and are intact (the signature is a valid 8,975-byte PNG; the font a valid TrueType
-- file), and this function returned them exactly. The text was changed on the way to the browser: 20 characters were
-- inserted. Base64 that starts "iVBORw0KGgo" is a recognizable PNG, and content filters on some connections inspect
-- and rewrite embedded images. Hex doesn't look like an image, so it passes untouched. The bytes are the same.

drop function if exists public.check_asset(text, text);
create function public.check_asset(p_kind text, p_account text default '')
returns table (file_name text, mime text, data_hex text, transit_char text, onus_char text, updated_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.require_admin();
  return query
  select a.file_name, a.mime, encode(a.content, 'hex'), a.transit_char, a.onus_char, a.updated_at
  from public.check_assets a
  where a.org_id = public.current_org_id() and a.kind = p_kind and a.account_id = coalesce(p_account, '');
end $$;

revoke execute on function public.check_asset(text, text) from public, anon;
grant execute on function public.check_asset(text, text) to authenticated;
