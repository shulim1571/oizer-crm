-- A fundraiser asks the office for a receipt for a donation on one of their campaigns (Moshe Henig, 2026-11-12). It
-- lands on the admin Task Sheet as Receipt Requested, exactly like the donor's "Send me a receipt" (same task, same
-- key, so asking twice doesn't make two), and admins still issue and send the receipt. Sent to the email or phone
-- given, or else the donor's own on file. The request closes itself once the receipt is sent, as the donor's does.
create or replace function public.fundraiser_request_receipt(p_donation text, p_email text default null, p_phone text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  d public.donations;
  v_donor public.donors;
  v_who text;
  v_email text := nullif(lower(trim(p_email)), '');
  v_phone text := nullif(trim(p_phone), '');
begin
  if v_org is null or public.my_org_role() is distinct from 'manager' then raise exception 'Only a fundraiser can request a receipt here'; end if;
  select * into d from public.donations where org_id = v_org and id = p_donation and deleted_at is null;
  if d.id is null then raise exception 'Donation not found'; end if;
  if not (d.campaign_id = any(coalesce(public.my_campaign_ids(), '{}'))) then raise exception 'You can request receipts only for donations to your own campaigns'; end if;
  if d.status not in ('completed', 'collect') then raise exception 'Only a completed donation can have a receipt'; end if;
  if d.donor_id is not null then select * into v_donor from public.donors where org_id = v_org and id = d.donor_id; end if;
  v_email := coalesce(v_email, nullif(lower(trim(v_donor.email)), ''), nullif(lower(trim(d.email)), ''));
  v_phone := coalesce(v_phone, nullif(trim(v_donor.phone), ''), nullif(trim(d.phone), ''));
  if v_email is null and v_phone is null then raise exception 'Enter the donor''s email address or phone number for the receipt'; end if;
  if v_email is not null and public.normalize_address('email', v_email) is null then raise exception 'Check the email address'; end if;
  select coalesce(m.full_name, public.current_email()) into v_who from public.managers m
    where m.org_id = v_org and m.id = any(public.my_manager_ids()) order by m.full_name limit 1;
  insert into public.task_items (org_id, task_key, task_type, record_id, campaign_id, amount, summary, detail)
  values (v_org, 'receipt_requested:' || d.id, 'receipt_requested', d.id, d.campaign_id, d.amount,
          coalesce(v_who, 'A fundraiser') || ' asked for a receipt for ' || coalesce(v_donor.display_name, nullif(d.name, ''), 'a donor') || ' by '
            || concat_ws(' and ', case when v_email is not null then 'email (' || v_email || ')' end, case when v_phone is not null then 'text (' || v_phone || ')' end),
          jsonb_build_object('email', v_email, 'phone', v_phone, 'requested_by', public.current_email()))
  on conflict (org_id, task_key) do update set summary = excluded.summary, detail = excluded.detail, created_at = now(), resolved_at = null;
end $$;
revoke execute on function public.fundraiser_request_receipt(text, text, text) from public, anon;
grant execute on function public.fundraiser_request_receipt(text, text, text) to authenticated;
