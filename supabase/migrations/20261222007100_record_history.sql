-- Readiness #46 (2026-11-15): a readable history for donations, payouts and transfers (who, when, field, old to new),
-- from the activity log, which only admins could read, as raw key/value pairs.
--
-- record_history(table, id): admins see a record's whole history. A fundraiser sees it only for records on their own
-- campaigns (a transfer counts if either side is theirs), without bank details, payee details, card details or the
-- IP address, and with the office's people shown as "The office" (their own changes keep their email).

create or replace function public.record_history(p_table text, p_id text)
returns table (created_at timestamptz, who text, action text, changes jsonb)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  v_admin boolean := public.is_admin();
  v_me text := public.current_email();
  v_campaigns text[] := public.my_campaign_ids();
  v_ok boolean;
  v_hidden text[] := array['org_id', 'account_id', 'bank_reference', 'gateway_id', 'donary_id', 'card_last4', 'card_type', 'masked_card',
                           'payee', 'payee_id', 'payee_address', 'routing', 'account_number', 'zelle', 'ip', 'user_id', 'created_by', 'updated_by'];
begin
  if p_table not in ('donations', 'expenses', 'transfers') then raise exception 'No history for that'; end if;
  if not v_admin then
    v_ok := case p_table
      when 'donations' then exists (select 1 from public.donations d where d.org_id = v_org and d.id = p_id and d.campaign_id = any(v_campaigns))
      when 'expenses' then exists (select 1 from public.expenses e where e.org_id = v_org and e.id = p_id and e.campaign_id = any(v_campaigns))
      else exists (select 1 from public.transfers t where t.org_id = v_org and t.id = p_id
                     and (t.from_campaign_id = any(v_campaigns) or t.to_campaign_id = any(v_campaigns)))
    end;
    if not coalesce(v_ok, false) then return; end if;
  end if;
  return query
    select a.created_at,
           case when v_admin or a.user_email = v_me then a.user_email
                when a.user_email = 'system' then 'Automatic'
                else 'The office' end,
           a.action,
           case when v_admin then a.changes - 'org_id'
                else coalesce((select jsonb_object_agg(k, v) from jsonb_each(a.changes) as e(k, v) where k <> all(v_hidden)), '{}'::jsonb) end
    from public.activity_log a
    where a.org_id = v_org and a.table_name = p_table and a.record_id = p_id
    order by a.created_at desc, a.id desc;
end $$;
revoke execute on function public.record_history(text, text) from public, anon;
grant execute on function public.record_history(text, text) to authenticated;
