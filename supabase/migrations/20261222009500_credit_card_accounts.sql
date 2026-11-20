-- Credit cards as accounts (Moshe, approved 2026-11-20):
--   * each card is its own account (kind 'credit_card'), with its last 4, the bank account that pays its bill, and the
--     day the bill is due (optional);
--   * a payout charged to a card is recorded against the card account (method "Credit Card", set automatically); it
--     comes off its campaign's balance like any payout;
--   * what's owed on each card is shown next to the bank balance that pays it, as earmarked;
--   * paying the bill is one bank-to-card transfer (account_transfers), which touches no campaign.

alter table public.accounts add column if not exists kind text not null default 'bank' check (kind in ('bank', 'credit_card'));
alter table public.accounts add column if not exists card_last4 text check (card_last4 ~ '^[0-9]{4}$');
alter table public.accounts add column if not exists pays_from_account_id text;
alter table public.accounts add column if not exists bill_due_day integer check (bill_due_day between 1 and 31);

create or replace function public.account_card_rules() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.kind = 'credit_card' then
    if new.pays_from_account_id = new.id then raise exception 'A card''s bill is paid from a bank account, not from the card itself'; end if;
    if new.pays_from_account_id is not null and exists (select 1 from public.accounts a where a.org_id = new.org_id and a.id = new.pays_from_account_id and a.kind = 'credit_card') then
      raise exception 'Choose a bank account to pay the card''s bill from';
    end if;
  else
    new.card_last4 := null; new.pays_from_account_id := null; new.bill_due_day := null;
  end if;
  return new;
end $$;
revoke execute on function public.account_card_rules() from public, anon, authenticated;
drop trigger if exists account_card_rules on public.accounts;
create trigger account_card_rules before insert or update on public.accounts for each row execute function public.account_card_rules();

-- A payout charged to a card account is a card payout.
create or replace function public.card_payout_method() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.account_id is not null and (tg_op = 'INSERT' or new.account_id is distinct from old.account_id or new.method is distinct from old.method)
     and exists (select 1 from public.accounts a where a.org_id = new.org_id and a.id = new.account_id and a.kind = 'credit_card') then
    new.method := 'Credit Card';
    new.check_number := null;
  end if;
  return new;
end $$;
revoke execute on function public.card_payout_method() from public, anon, authenticated;
drop trigger if exists card_payout_method on public.expenses;
create trigger card_payout_method before insert or update on public.expenses for each row execute function public.card_payout_method();

-- Transfers between the organization's own accounts (a card bill paid from the bank). Not between campaigns.
create table if not exists public.account_transfers (
  org_id          uuid not null default public.current_org_id() references public.organizations(id),
  id              text not null default public.short_id(),
  from_account_id text not null,
  to_account_id   text not null,
  amount          numeric(12,2) not null check (amount > 0),
  paid_on         date not null default public.org_today(),
  reference       text,
  memo            text,
  created_by      text default public.current_email(),
  created_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  primary key (org_id, id),
  check (from_account_id <> to_account_id)
);
alter table public.account_transfers enable row level security;
revoke all on public.account_transfers from anon;
grant select on public.account_transfers to authenticated;
drop policy if exists org_wall on public.account_transfers;
create policy org_wall on public.account_transfers as restrictive for all to authenticated
  using (org_id = (select public.current_org_id())) with check (org_id = (select public.current_org_id()));
drop policy if exists admin_read on public.account_transfers;
create policy admin_read on public.account_transfers for select to authenticated using ((select public.is_admin()));

-- Pay a card's bill: one transfer from the bank account to the card account.
create or replace function public.pay_card_bill(p_card text, p_from text, p_amount numeric, p_date date default null,
                                                p_reference text default null, p_memo text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_id text;
begin
  perform public.require_admin();
  if not exists (select 1 from public.accounts a where a.org_id = v_org and a.id = p_card and a.kind = 'credit_card' and a.deleted_at is null) then
    raise exception 'Choose the card whose bill this pays';
  end if;
  if not exists (select 1 from public.accounts a where a.org_id = v_org and a.id = p_from and a.kind = 'bank' and a.deleted_at is null) then
    raise exception 'Choose the bank account it was paid from';
  end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Enter the amount paid'; end if;
  insert into public.account_transfers (org_id, from_account_id, to_account_id, amount, paid_on, reference, memo)
  values (v_org, p_from, p_card, round(p_amount, 2), coalesce(p_date, public.org_today()), nullif(trim(p_reference), ''), nullif(trim(p_memo), ''))
  returning id into v_id;
  perform public.write_activity(v_org, 'card_bill_paid', 'account_transfers', v_id, null,
    jsonb_build_object('card', p_card, 'from', p_from, 'amount', p_amount));
  return v_id;
end $$;
revoke execute on function public.pay_card_bill(text, text, numeric, date, text, text) from public, anon;
grant execute on function public.pay_card_bill(text, text, numeric, date, text, text) to authenticated;

-- Undo a bill payment entered by mistake (kept, marked deleted).
create or replace function public.delete_account_transfer(p_id text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  perform public.require_admin();
  update public.account_transfers set deleted_at = now() where org_id = v_org and id = p_id and deleted_at is null;
  if not found then raise exception 'Not found'; end if;
  perform public.write_activity(v_org, 'card_bill_payment_removed', 'account_transfers', p_id, null, '{}'::jsonb);
end $$;
revoke execute on function public.delete_account_transfer(text) from public, anon;
grant execute on function public.delete_account_transfer(text) to authenticated;

-- The account list: kind and card details, transfers in and out, the book balance of a bank account, what's owed on a
-- card, and for a bank account what its cards owe (earmarked) and what's left after them. (Columns added at the end.)
do $$
declare v_def text; v_new text; v_opts text;
begin
  v_def := pg_get_viewdef('public.account_summary'::regclass);
  v_new := replace(v_def, $s$    COALESCE(e.returned_in, (0)::numeric) AS returned_in
   FROM ((accounts a$s$,
$s$    COALESCE(e.returned_in, (0)::numeric) AS returned_in,
    a.kind,
    a.card_last4,
    a.pays_from_account_id,
    a.bill_due_day,
    COALESCE(ti.amount, (0)::numeric) AS transfers_in,
    COALESCE(tout.amount, (0)::numeric) AS transfers_out,
    CASE WHEN a.kind = 'credit_card' THEN COALESCE(e.expenses_total, (0)::numeric) - COALESCE(ti.amount, (0)::numeric) END AS card_owed,
    CASE WHEN a.kind = 'bank' THEN COALESCE(d.donations_total, (0)::numeric) - COALESCE(e.expenses_total, (0)::numeric)
                                   + COALESCE(ti.amount, (0)::numeric) - COALESCE(tout.amount, (0)::numeric) END AS book_balance,
    CASE WHEN a.kind = 'bank' THEN COALESCE(cards.owed, (0)::numeric) END AS earmarked_for_cards,
    CASE WHEN a.kind = 'bank' THEN COALESCE(d.donations_total, (0)::numeric) - COALESCE(e.expenses_total, (0)::numeric)
                                   + COALESCE(ti.amount, (0)::numeric) - COALESCE(tout.amount, (0)::numeric) - COALESCE(cards.owed, (0)::numeric) END AS available_after_cards
   FROM (((((accounts a$s$);
  if v_new = v_def then raise exception 'account_summary: select list not found'; end if;
  v_def := v_new;
  v_new := replace(v_def, $s$          GROUP BY expenses.org_id, expenses.account_id) e ON (((e.org_id = a.org_id) AND (e.account_id = a.id))))
  WHERE$s$,
$s$          GROUP BY expenses.org_id, expenses.account_id) e ON (((e.org_id = a.org_id) AND (e.account_id = a.id))))
     LEFT JOIN ( SELECT t.org_id, t.to_account_id AS account_id, sum(t.amount) AS amount FROM account_transfers t WHERE t.deleted_at IS NULL
          GROUP BY t.org_id, t.to_account_id) ti ON (((ti.org_id = a.org_id) AND (ti.account_id = a.id))))
     LEFT JOIN ( SELECT t.org_id, t.from_account_id AS account_id, sum(t.amount) AS amount FROM account_transfers t WHERE t.deleted_at IS NULL
          GROUP BY t.org_id, t.from_account_id) tout ON (((tout.org_id = a.org_id) AND (tout.account_id = a.id))))
     LEFT JOIN ( SELECT c.org_id, c.pays_from_account_id AS account_id,
                        sum(GREATEST(COALESCE((SELECT sum(x.amount) FROM expenses x WHERE x.org_id = c.org_id AND x.account_id = c.id AND x.deleted_at IS NULL), (0)::numeric)
                                   - COALESCE((SELECT sum(y.amount) FROM account_transfers y WHERE y.org_id = c.org_id AND y.to_account_id = c.id AND y.deleted_at IS NULL), (0)::numeric), (0)::numeric)) AS owed
                   FROM accounts c WHERE c.kind = 'credit_card' AND c.deleted_at IS NULL AND c.pays_from_account_id IS NOT NULL
                  GROUP BY c.org_id, c.pays_from_account_id) cards ON (((cards.org_id = a.org_id) AND (cards.account_id = a.id))))
  WHERE$s$);
  if v_new = v_def then raise exception 'account_summary: joins not found'; end if;
  select coalesce('with (' || array_to_string(reloptions, ', ') || ')', '') into v_opts from pg_class where oid = 'public.account_summary'::regclass;
  execute format('create or replace view public.account_summary %s as %s', v_opts, v_new);
end $$;
