-- Moshe, Nov 16 8:52 PM ET: "just the opposite the first number is the home and the second is the cell".
-- Two unlabeled numbers in a donor's Phone: first to Home, second to Cell (20261222008200 had them the other way).
-- Labeled numbers (home / H, cell / C / mobile) still go by their label. A single number still goes to Cell, so texts
-- reach it. Phone, kept in step with the two boxes, now reads "home, cell", the order the numbers came in.
--
-- Nobody has edited a donor's phones since the first split (only the migration's own 'system' entries in the
-- activity log, and no donors added since), so every donor's Cell and Home are re-split from their Phone, which still
-- holds the numbers exactly as imported. Phone itself isn't rewritten here.

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
  -- Unlabeled: two or more, first to Home and second to Cell; just one, to Cell (or Home, if a label took Cell).
  if array_length(loose, 1) >= 2 and home is null and cell is null then
    home := loose[1];
    cell := loose[2];
  else
    foreach num in array loose loop
      if cell is null then cell := num; elsif home is null then home := num; end if;
    end loop;
  end if;
  if cell is null and home is null then cell := trim(p); end if;
end $$;

create or replace function public.donor_phones_sync() returns trigger
language plpgsql set search_path = '' as $$
declare s record;
begin
  new.cell_phone := nullif(trim(new.cell_phone), '');
  new.home_phone := nullif(trim(new.home_phone), '');
  if coalesce(current_setting('oizer.phone_resplit', true), '') = 'on' then
    return new;                                  -- the re-split below: Phone stays as imported
  end if;
  if tg_op = 'UPDATE' and (new.cell_phone is distinct from old.cell_phone or new.home_phone is distinct from old.home_phone) then
    new.phone := nullif(concat_ws(', ', new.home_phone, new.cell_phone), '');
  elsif (tg_op = 'UPDATE' and new.phone is distinct from old.phone)
        or (tg_op = 'INSERT' and new.cell_phone is null and new.home_phone is null) then
    s := public.split_phones(new.phone);
    new.cell_phone := s.cell;
    new.home_phone := s.home;
  elsif tg_op = 'INSERT' and nullif(trim(new.phone), '') is null then
    new.phone := nullif(concat_ws(', ', new.home_phone, new.cell_phone), '');
  end if;
  return new;
end $$;

-- Re-split everyone from Phone.
select set_config('oizer.phone_resplit', 'on', true);
update public.donors d set cell_phone = s.cell, home_phone = s.home
from public.donors x cross join lateral public.split_phones(x.phone) s
where d.org_id = x.org_id and d.id = x.id and nullif(trim(x.phone), '') is not null
  and (d.cell_phone is distinct from s.cell or d.home_phone is distinct from s.home);
select set_config('oizer.phone_resplit', '', true);
