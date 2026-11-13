-- The voucher form has one fee field (Moshe Henig, 2026-11-11: "remove the Issuer Ref # field and all the fee
-- options; leave just one field to enter the fee amount"). A typed amount is a flat fee taken when funds arrive; left
-- empty, the issuer's rate from Methods & Fees applies as before. Existing vouchers keep their fees, and a fee still
-- can't change once funds have arrived. The issuer's ref. # column and its data stay; only the form field goes.

-- No column default, so "no fee typed" (null) can be told from a typed 0; the trigger still stores 0 when empty.
alter table public.vouchers alter column fee_flat drop default;

create or replace function public.voucher_defaults() returns trigger
language plpgsql security definer set search_path = '' as $function$
declare m public.payment_methods;
begin
  if tg_op = 'INSERT' then
    new.id := public.next_reference(new.org_id, 'VCH');
    -- A fee amount typed on the form is a flat fee; none typed uses the issuer's rate.
    if new.fee_type is null and new.fee_flat is not null then
      new.fee_type := 'flat';
      new.fee_percent := 0;
    elsif new.fee_type is null then
      select * into m from public.payment_methods p where p.org_id = new.org_id and lower(p.name) = lower(new.issuer);
      new.fee_type := coalesce(m.fee_type, 'none');
      new.fee_percent := coalesce(m.fee_percent, 0);
      new.fee_flat := coalesce(m.fee_flat, 0);
    end if;
  end if;
  new.fee_percent := coalesce(new.fee_percent, 0);
  new.fee_flat := coalesce(new.fee_flat, 0);
  if new.submission = 'online' then new.account_number := null; end if;

  -- Changing the fee amount on the form makes it that flat fee (the form has no other fee choices now).
  if tg_op = 'UPDATE' and new.fee_flat is distinct from old.fee_flat and new.fee_type is not distinct from old.fee_type then
    new.fee_type := 'flat';
    new.fee_percent := 0;
  end if;

  if tg_op = 'UPDATE' then
    declare v_funded numeric := public.voucher_funded(new.org_id, new.id);
    begin
      if v_funded > 0 then
        if new.campaign_id is distinct from old.campaign_id then
          raise exception 'This voucher has funding on its campaign and can''t be moved';
        end if;
        if (new.fee_type, new.fee_percent, new.fee_flat) is distinct from (old.fee_type, old.fee_percent, old.fee_flat) then
          raise exception 'The fee is set once and can''t change after funds have arrived';
        end if;
        if new.deleted_at is not null and old.deleted_at is null then
          raise exception 'This voucher has funding. Delete its funding entries first';
        end if;
      end if;
      if new.face_value < v_funded then
        raise exception 'Face value can''t be less than the % already funded', v_funded;
      end if;
    end;
  end if;
  return new;
end $function$;
