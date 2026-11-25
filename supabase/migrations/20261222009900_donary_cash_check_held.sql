-- Donary cash and check gifts (Shulim, 2026-11-25). A cash or check gift that comes in from Donary (the Make feed or
-- Donary's own webhook) only says a fundraiser wrote it down; the money may never reach the office. So it arrives
-- "held": recorded, but not counted anywhere (raised, fees, balances, campaign progress, dashboard, bank matching,
-- pledges), not receipted and no new-gift alert, since all of those count only completed gifts. Marking it delivered
-- (Mark delivered on the review list, or ticking Delivered on the gift) makes it a completed gift, which counts.
--
-- The organization setting donary_cash_check_mode decides what staff see:
--   'ignore' (the default) - held gifts stay out of the way;
--   'review'               - they're listed on Transactions > Donary cash & checks to be marked delivered.
-- Either way they don't count until marked delivered.
--
-- Existing Donary cash and check gifts follow the same rule: completed ones become held, unless they were already
-- marked delivered (the old system's Delivered, carried over in the import), are on a deposit slip, have a receipt, or
-- are matched to the bank; those were delivered and keep counting.

alter table public.donations drop constraint if exists donations_status_check;
alter table public.donations add constraint donations_status_check check (status = any (array[
  'completed', 'pending', 'post_dated', 'collect', 'voided', 'refunded', 'returned', 'failed', 'rejected', 'disputed', 'chargeback', 'held']));

-- Staff can void a held gift; making it count goes through marking it delivered.
create or replace function public.donation_status_allowed(p_from text, p_to text)
returns boolean language sql immutable set search_path = '' as $$
  select p_from is not distinct from p_to or (p_from, p_to) in (
    ('pending', 'completed'), ('pending', 'rejected'),
    ('post_dated', 'completed'), ('post_dated', 'voided'), ('post_dated', 'returned'),
    ('collect', 'completed'), ('collect', 'voided'), ('collect', 'failed'), ('collect', 'refunded'), ('collect', 'returned'),
    ('completed', 'voided'), ('completed', 'refunded'), ('completed', 'returned'), ('completed', 'collect'),
    ('held', 'voided')
  )
$$;

create or replace function public.is_cash_or_check(p_method text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(p_method ~* '(cash|check|cheque)', false)
$$;

-- Holds a Donary cash or check gift as it comes in, keeps it held when Donary sends it again, and lets it count once
-- it's marked delivered. Runs after the payment method's aliases are applied (ab_method_alias) and before the fee and
-- post-dated rules (donation_defaults).
create or replace function public.donary_cash_check_hold() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    -- One with a card-processor reference was collected by the processor (an electronic check), so it isn't held.
    if new.donary_id is not null and new.status = 'completed' and public.is_cash_or_check(new.payment_method)
       and new.delivered is not true and coalesce(new.gateway_id, '') = '' then
      new.status := 'held';
    end if;
    return new;
  end if;
  if old.status = 'held' then
    if (new.delivered is true and old.delivered is not true) or current_setting('oizer.deliver_held', true) = 'on' then
      -- Marked delivered: it counts from now on.
      if new.status = 'held' then new.status := 'completed'; end if;
      new.delivered := true;
    elsif new.status = 'completed' then
      -- Anything else trying to complete it (Donary sending the gift again) leaves it held.
      new.status := 'held';
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.donary_cash_check_hold() from public, anon, authenticated;
drop trigger if exists ac_donary_cash_check_hold on public.donations;
create trigger ac_donary_cash_check_hold before insert or update on public.donations
  for each row execute function public.donary_cash_check_hold();

-- Mark held gifts delivered (admins): each becomes a completed gift and counts. Returns how many were marked.
create or replace function public.mark_donary_delivered(p_ids text[]) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_n integer;
begin
  perform public.require_admin();
  perform set_config('oizer.deliver_held', 'on', true);
  update public.donations d set delivered = true
  where d.org_id = v_org and d.id = any(p_ids) and d.status = 'held' and d.deleted_at is null;
  get diagnostics v_n = row_count;
  perform set_config('oizer.deliver_held', 'off', true);
  if v_n > 0 then
    perform public.write_activity(v_org, 'donary_marked_delivered', 'donations', null, null, jsonb_build_object('ids', to_jsonb(p_ids), 'count', v_n));
  end if;
  return v_n;
end $$;
revoke execute on function public.mark_donary_delivered(text[]) from public, anon;
grant execute on function public.mark_donary_delivered(text[]) to authenticated;

-- The campaign's "last donation" time doesn't count a held gift either.
do $$
declare v_def text; v_new text; v_opts text;
begin
  v_def := pg_get_viewdef('public.campaign_summary'::regclass);
  -- However Postgres writes it back (table alias, brackets), e.g. FILTER (WHERE (x.status <> 'failed'::text)).
  v_new := regexp_replace(v_def, $s$\(WHERE \(?(\w+)\.status <> 'failed'::text\)?\) AS last_donation_at$s$,
                          $s$(WHERE (\1.status <> ALL (ARRAY['failed'::text, 'held'::text]))) AS last_donation_at$s$);
  if v_new = v_def then raise exception 'campaign_summary: last_donation_at not found'; end if;
  select coalesce('with (' || array_to_string(reloptions, ', ') || ')', '') into v_opts from pg_class where oid = 'public.campaign_summary'::regclass;
  execute format('create or replace view public.campaign_summary %s as %s', v_opts, v_new);
end $$;

-- Existing Donary cash and check gifts: the same rule (see the top). The system's own change, so the app's edit
-- guard doesn't apply; the change log records each one.
do $$
begin
  perform set_config('oizer.trusted_edit', 'on', true);
  update public.donations d set status = 'held'
  where d.donary_id is not null and d.deleted_at is null and d.status = 'completed'
    and public.is_cash_or_check(d.payment_method) and d.delivered is not true and d.deposit_slip_id is null and coalesce(d.gateway_id, '') = ''
    and not exists (select 1 from public.receipts r where r.org_id = d.org_id and (r.donation_id = d.id or d.id = any(r.donation_ids)))
    and not exists (select 1 from public.recon_match_items i where i.org_id = d.org_id and i.item_id = d.id and i.item_type ilike 'donation%');
  perform set_config('oizer.trusted_edit', 'off', true);
end $$;
