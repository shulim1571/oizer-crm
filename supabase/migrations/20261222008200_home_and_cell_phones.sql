-- Moshe, Nov 16 (approved by Shulim): donors get a Cell phone and a Home phone instead of one Phone box.
--
-- Moving the numbers on file (option A, no cost): a Phone holding two numbers is split by their labels (home / H to
-- Home; cell / C / mobile to Cell); two numbers without labels go first to Cell, second to Home; a single number goes
-- to Cell. Option B (checking each single number with Twilio Lookup, about $30) is not done; it needs approval.
--
-- The Phone column stays. Nothing in it is wiped: from now on it holds "cell, home", kept in step with the two new
-- boxes, so search, imports, receipts, duplicate checks and the Donary feed keep reading it as before. An import
-- that writes Phone is split the same way. Texts to donors go to the Cell number.

alter table public.donors add column if not exists cell_phone text;
alter table public.donors add column if not exists home_phone text;

create or replace function public.split_phones(p text, out cell text, out home text)
language plpgsql immutable set search_path = '' as $$
declare m text[]; lab text; num text; loose text[] := '{}';
begin
  if nullif(trim(p), '') is null then return; end if;
  for m in select regexp_matches(p,
      '(?:\m(home|h|cell|c|mobile|mob)\M\.?\s*[:=-]?\s*)?(\+?\(?\d[\d().\s-]{5,}\d)(?:\s*\(?\m(home|h|cell|c|mobile|mob)\M\)?)?', 'gi') loop
    lab := lower(coalesce(m[1], m[3], ''));
    num := trim(m[2]);
    if lab in ('home', 'h') and home is null then home := num;
    elsif lab in ('cell', 'c', 'mobile', 'mob') and cell is null then cell := num;
    else loose := loose || num;
    end if;
  end loop;
  foreach num in array loose loop
    if cell is null then cell := num; elsif home is null then home := num; end if;
  end loop;
  if cell is null and home is null then cell := trim(p); end if;
end $$;
revoke execute on function public.split_phones(text) from public, anon;
grant execute on function public.split_phones(text) to authenticated;

-- The numbers on file.
update public.donors d set cell_phone = s.cell, home_phone = s.home
from public.donors x cross join lateral public.split_phones(x.phone) s
where d.org_id = x.org_id and d.id = x.id and nullif(trim(x.phone), '') is not null
  and d.cell_phone is null and d.home_phone is null;

-- Keep Phone and the two boxes in step.
create or replace function public.donor_phones_sync() returns trigger
language plpgsql set search_path = '' as $$
declare s record;
begin
  new.cell_phone := nullif(trim(new.cell_phone), '');
  new.home_phone := nullif(trim(new.home_phone), '');
  if tg_op = 'UPDATE' and (new.cell_phone is distinct from old.cell_phone or new.home_phone is distinct from old.home_phone) then
    new.phone := nullif(concat_ws(', ', new.cell_phone, new.home_phone), '');
  elsif (tg_op = 'UPDATE' and new.phone is distinct from old.phone)
        or (tg_op = 'INSERT' and new.cell_phone is null and new.home_phone is null) then
    s := public.split_phones(new.phone);
    new.cell_phone := s.cell;
    new.home_phone := s.home;
  elsif tg_op = 'INSERT' and nullif(trim(new.phone), '') is null then
    new.phone := nullif(concat_ws(', ', new.cell_phone, new.home_phone), '');
  end if;
  return new;
end $$;
revoke execute on function public.donor_phones_sync() from public, anon, authenticated;
drop trigger if exists donor_phones_sync on public.donors;
create trigger donor_phones_sync before insert or update on public.donors
  for each row execute function public.donor_phones_sync();

-- The donor list shows both.
do $$
declare v_def text; v_new text; v_opts text;
begin
  v_def := pg_get_viewdef('public.donor_summary'::regclass);
  v_new := replace(v_def, $s$COALESCE(p.open_pledges, (0)::numeric) AS open_pledges
   FROM$s$, $s$COALESCE(p.open_pledges, (0)::numeric) AS open_pledges,
    dn.cell_phone,
    dn.home_phone
   FROM$s$);
  if v_new = v_def then raise exception 'donor_summary: select list not found'; end if;
  select coalesce('with (' || array_to_string(reloptions, ', ') || ')', '') into v_opts from pg_class where oid = 'public.donor_summary'::regclass;
  execute format('create or replace view public.donor_summary %s as %s', v_opts, v_new);
end $$;

-- Texts to donors go to the Cell number (a Phone with two numbers isn't one number a text can go to).
do $$
declare v_def text; v_new text;
begin
  select pg_get_functiondef('public.outreach_group'::regproc) into v_def;
  v_new := replace(v_def, 'dn.email, dn.phone,', 'dn.email, coalesce(dn.cell_phone, dn.phone),');
  if v_new = v_def then raise exception 'outreach_group: phone not found'; end if;
  execute v_new;

  select pg_get_functiondef('public.send_outreach'::regproc) into v_def;
  v_new := replace(v_def, 'dn.display_name, dn.email, dn.phone, dn.id into', 'dn.display_name, dn.email, coalesce(dn.cell_phone, dn.phone), dn.id into');
  if v_new = v_def then raise exception 'send_outreach: phone not found'; end if;
  execute v_new;

  select pg_get_functiondef('public.fundraiser_request_receipt'::regproc) into v_def;
  v_new := replace(v_def, 'nullif(trim(v_donor.phone), '''')', 'coalesce(nullif(trim(v_donor.cell_phone), ''''), nullif(trim(v_donor.phone), ''''))');
  if v_new = v_def then raise exception 'fundraiser_request_receipt: phone not found'; end if;
  execute v_new;
end $$;
