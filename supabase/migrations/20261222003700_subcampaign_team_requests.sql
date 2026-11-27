-- Fundraisers request sub-campaigns and teams the same way they request campaigns (Moshe Henig, 2026-11-15). A request
-- under one of their own campaigns now says which it is: a sub-campaign (its own balance) or a team (raises into the
-- parent's balance). It goes through the same approval as a campaign request: it shows on the Task Sheet ("team of" /
-- "sub-campaign of"), and the admin approves (with the requested type picked, changeable), asks for changes or rejects.
-- Requests from before this keep no type; the admin picks, as before.
alter table public.campaign_requests add column if not exists requested_mode text check (requested_mode in ('shared', 'independent'));

drop function if exists public.submit_campaign_request(text, text, numeric, text, text);
CREATE FUNCTION public.submit_campaign_request(p_name text, p_description text DEFAULT NULL::text, p_goal numeric DEFAULT NULL::numeric, p_notes text DEFAULT NULL::text, p_parent text DEFAULT NULL::text, p_mode text DEFAULT NULL::text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_managers text[] := public.my_manager_ids();
  v_id text;
begin
  if coalesce(array_length(v_managers, 1), 0) = 0 then
    raise exception 'Only a fundraiser can request a campaign';
  end if;
  if nullif(trim(p_name), '') is null then raise exception 'A request needs a campaign name'; end if;
  if p_parent is not null and not (p_parent = any(public.my_campaign_ids())) then
    raise exception 'You can only request a sub-campaign under your own campaigns';
  end if;
  if p_mode is not null and p_mode not in ('shared', 'independent') then raise exception 'Choose a team or a sub-campaign'; end if;
  if p_mode is not null and p_parent is null then raise exception 'Choose the campaign it goes under'; end if;
  insert into public.campaign_requests (org_id, manager_id, name, description, goal, notes, parent_campaign_id, requested_mode)
  values (public.current_org_id(), v_managers[1], trim(p_name), nullif(p_description, ''), p_goal, nullif(p_notes, ''), p_parent,
          case when p_parent is not null then coalesce(p_mode, 'independent') end)
  returning id into v_id;
  return v_id;
end $function$;
revoke execute on function public.submit_campaign_request(text, text, numeric, text, text, text) from public, anon;
grant execute on function public.submit_campaign_request(text, text, numeric, text, text, text) to authenticated;

create or replace view public.admin_task_sheet with (security_invoker = true) as
 WITH items AS (
         SELECT r.org_id,
            'campaign_request:'::text || r.id AS task_key,
                CASE
                    WHEN r.resubmitted_at IS NULL THEN 'campaign_request'::text
                    ELSE 'changes_resubmitted'::text
                END AS task_type,
            r.id AS record_id,
            r.parent_campaign_id AS campaign_id,
            m.full_name AS fundraiser,
            r.goal AS amount,
            COALESCE(r.resubmitted_at, r.created_at) AS submitted_at,
            r.name ||
                CASE
                    WHEN r.parent_campaign_id IS NOT NULL THEN (((' ('::text || CASE WHEN r.requested_mode = 'shared'::text THEN 'team'::text ELSE 'sub-campaign'::text END) || ' of '::text) || r.parent_campaign_id) || ')'::text
                    ELSE ''::text
                END AS summary
           FROM campaign_requests r
             LEFT JOIN managers m ON m.org_id = r.org_id AND m.id = r.manager_id
          WHERE r.status = 'pending'::text
        UNION ALL
         SELECT t.org_id,
            'team_request:'::text || t.id,
            'team_request'::text,
            t.id,
            t.campaign_id,
            t.requested_by_email,
            NULL::numeric,
            t.created_at,
            (COALESCE(t.person_name, t.email, t.phone) || ' as '::text) || t.role
           FROM campaign_team_requests t
          WHERE t.status = 'pending'::text
        UNION ALL
         SELECT d.org_id,
            'pending_payment:'::text || d.id,
            'pending_payment'::text,
            d.id,
            d.campaign_id,
            m.full_name,
            d.amount,
            d.created_at,
            COALESCE(d.payment_method, 'Payment'::text) || COALESCE(' from '::text || NULLIF(d.name, ''::text), ''::text)
           FROM donations d
             LEFT JOIN campaigns c_1 ON c_1.org_id = d.org_id AND c_1.id = d.campaign_id
             LEFT JOIN managers m ON m.org_id = c_1.org_id AND m.id = c_1.manager_id
          WHERE d.status = 'pending'::text AND d.deleted_at IS NULL
        UNION ALL
         SELECT d.org_id,
            'unattributed:'::text || d.id,
            'unattributed'::text,
            d.id,
            NULL::text,
            NULL::text,
            d.amount,
            d.created_at,
            (COALESCE(d.payment_method, 'Payment'::text) || COALESCE(' from '::text || NULLIF(d.name, ''::text), ''::text)) || COALESCE(' · ref '::text || d.batch_id, ''::text)
           FROM donations d
          WHERE d.campaign_id IS NULL AND (d.status = ANY (ARRAY['completed'::text, 'collect'::text])) AND d.deleted_at IS NULL
        UNION ALL
         SELECT d.org_id,
            'returned_check:'::text || d.id,
            'returned_check'::text,
            d.id,
            d.campaign_id,
            m.full_name,
            d.amount,
            org_midnight(d.reversal_date) AS org_midnight,
            (('Check'::text || COALESCE(' #'::text || d.check_number, ''::text)) || COALESCE(' from '::text || NULLIF(d.name, ''::text), ''::text)) || COALESCE(' · '::text || d.reversal_reason, ''::text)
           FROM donations d
             LEFT JOIN campaigns c_1 ON c_1.org_id = d.org_id AND c_1.id = d.campaign_id
             LEFT JOIN managers m ON m.org_id = c_1.org_id AND m.id = c_1.manager_id
          WHERE d.status = 'returned'::text AND d.reversal_date IS NOT NULL AND d.deleted_at IS NULL
        UNION ALL
         SELECT d.org_id,
            'post_dated_due:'::text || d.id,
            'post_dated_due'::text,
            d.id,
            d.campaign_id,
            m.full_name,
            d.amount,
            org_midnight(d.check_date) AS org_midnight,
            (('Check'::text || COALESCE(' #'::text || d.check_number, ''::text)) || COALESCE(' from '::text || NULLIF(d.name, ''::text), ''::text)) || ' is ready to deposit'::text
           FROM donations d
             LEFT JOIN campaigns c_1 ON c_1.org_id = d.org_id AND c_1.id = d.campaign_id
             LEFT JOIN managers m ON m.org_id = c_1.org_id AND m.id = c_1.manager_id
          WHERE d.post_dated AND d.check_date <= CURRENT_DATE AND d.status = 'completed'::text AND d.deleted_at IS NULL
        UNION ALL
         SELECT v.org_id,
            (('voucher_overdue:'::text || v.id) || ':'::text) || COALESCE(v.expected_date::text, ''::text),
            'voucher_overdue'::text,
            v.id,
            v.campaign_id,
            m.full_name,
            v.remaining,
            org_midnight(COALESCE(v.expected_date, v.date_received + 30)) AS org_midnight,
            (((((v.id || COALESCE(' · issuer #'::text || v.issuer_number, ''::text)) || ' · '::text) || replace(v.issuer, 'Voucher — '::text, ''::text)) || COALESCE(' · '::text || v.donor_name, ''::text)) || ' · face '::text) || v.face_value
           FROM voucher_list v
             LEFT JOIN campaigns c_1 ON c_1.org_id = v.org_id AND c_1.id = v.campaign_id
             LEFT JOIN managers m ON m.org_id = c_1.org_id AND m.id = c_1.manager_id
          WHERE v.overdue
        UNION ALL
         SELECT p.org_id,
            (('pledge_overdue:'::text || p.id) || ':'::text) || COALESCE(p.next_due_date, p.expected_date)::text,
            'pledge_overdue'::text,
            p.id,
            p.campaign_id,
            m.full_name,
            p.balance,
            org_midnight(COALESCE(p.next_due_date, p.expected_date)) AS org_midnight,
            p.reference || COALESCE(' · '::text || p.donor_name, ''::text)
           FROM pledge_list p
             LEFT JOIN campaigns c_1 ON c_1.org_id = p.org_id AND c_1.id = p.campaign_id
             LEFT JOIN managers m ON m.org_id = c_1.org_id AND m.id = c_1.manager_id
          WHERE p.status = 'overdue'::text
        UNION ALL
         SELECT e.org_id,
            'stale_check:'::text || e.id,
            'stale_check'::text,
            e.id,
            e.campaign_id,
            m.full_name,
            e.amount,
            e.created_at,
            ('Check'::text || COALESCE(' #'::text || e.check_number, ''::text)) || COALESCE(' to '::text || NULLIF(e.payee, ''::text), ''::text)
           FROM expenses e
             LEFT JOIN campaigns c_1 ON c_1.org_id = e.org_id AND c_1.id = e.campaign_id
             LEFT JOIN managers m ON m.org_id = c_1.org_id AND m.id = c_1.manager_id
          WHERE e.method = 'Check'::text AND e.cleared IS NOT TRUE AND e.deleted_at IS NULL AND NOT (EXISTS ( SELECT 1
                   FROM checks k
                  WHERE k.org_id = e.org_id AND k.expense_id = e.id AND (k.status = ANY (ARRAY['voided'::text, 'lost'::text])))) AND e.created_at < (now() - make_interval(days => COALESCE(( SELECT (s.value #>> '{}'::text[])::integer AS int4
                   FROM settings s
                  WHERE s.org_id = e.org_id AND s.key = 'stale_check_days'::text), 90)))
        UNION ALL
         SELECT c_1.org_id,
            (('inactive_campaign:'::text || c_1.id) || ':'::text) || COALESCE(a.last_at, c_1.created_at)::date,
            'inactive_campaign'::text,
            c_1.id,
            c_1.id,
            m.full_name,
            NULL::numeric,
            COALESCE(a.last_at, c_1.created_at) AS "coalesce",
            'No activity since '::text || COALESCE(a.last_at, c_1.created_at)::date
           FROM campaigns c_1
             LEFT JOIN managers m ON m.org_id = c_1.org_id AND m.id = c_1.manager_id
             LEFT JOIN LATERAL ( SELECT GREATEST(( SELECT max(d.created_at) AS max
                           FROM donations d
                          WHERE d.org_id = c_1.org_id AND d.campaign_id = c_1.id AND d.deleted_at IS NULL), ( SELECT max(e.created_at) AS max
                           FROM expenses e
                          WHERE e.org_id = c_1.org_id AND e.campaign_id = c_1.id AND e.deleted_at IS NULL)) AS last_at) a ON true
          WHERE c_1.status = 'active'::text AND c_1.deleted_at IS NULL AND COALESCE(a.last_at, c_1.created_at) < (now() - make_interval(days => COALESCE(( SELECT (s.value #>> '{}'::text[])::integer AS int4
                   FROM settings s
                  WHERE s.org_id = c_1.org_id AND s.key = 'inactive_campaign_days'::text), 90)))
        UNION ALL
         SELECT c_1.org_id,
            'bank_reassign:'::text || c_1.id,
            'bank_reassign'::text,
            c_1.id,
            c_1.id,
            m.full_name,
            NULL::numeric,
            a.deleted_at,
            ('Its bank account "'::text || a.name) || '" was removed'::text
           FROM removed_accounts() a(org_id, id, name, deleted_at)
             JOIN campaigns c_1 ON c_1.org_id = a.org_id AND c_1.account_id = a.id
             LEFT JOIN managers m ON m.org_id = c_1.org_id AND m.id = c_1.manager_id
          WHERE c_1.deleted_at IS NULL AND c_1.status <> 'closed'::text
        UNION ALL
         SELECT b.org_id,
            'machine_booking:'::text || b.id,
            'machine_booking'::text,
            b.id,
            b.campaign_id,
            m.full_name,
            NULL::numeric,
            b.requested_at,
            ('Machine for '::text || to_char(b.booking_date::timestamp with time zone, 'FMMonth FMDD, YYYY'::text)) ||
                CASE
                    WHEN b.offered_at IS NOT NULL THEN ' · a machine opened up'::text
                    ELSE ''::text
                END
           FROM machine_bookings b
             LEFT JOIN managers m ON m.org_id = b.org_id AND m.id = b.manager_id
          WHERE b.status = 'pending'::text AND b.booking_date >= org_today()
        UNION ALL
         SELECT r.org_id,
            'payout_request:'::text || r.id,
            'payout_request'::text,
            r.id,
            r.campaign_id,
            m.full_name,
            r.amount,
            r.created_at,
            (((('To '::text || r.recipient_name) || ' by '::text) || r.method) ||
                CASE
                    WHEN r.full_balance THEN ' · full balance'::text
                    ELSE ''::text
                END) ||
                CASE
                    WHEN r.source = 'phone'::text THEN ' · by phone'::text
                    ELSE ''::text
                END
           FROM payout_requests r
             LEFT JOIN managers m ON m.org_id = r.org_id AND m.id = r.manager_id
          WHERE r.status = 'pending'::text
        UNION ALL
         SELECT e.org_id,
            'scheduled_payout:'::text || e.id,
            'scheduled_payout'::text,
            e.id,
            e.campaign_id,
            m.full_name,
            e.amount,
            org_midnight(e.scheduled_for) AS org_midnight,
            ((COALESCE(e.method, 'Payout'::text) || COALESCE(' to '::text || NULLIF(e.payee, ''::text), ''::text)) || ' was set for '::text) || to_char(e.scheduled_for::timestamp with time zone, 'FMMonth FMDD, YYYY'::text)
           FROM expenses e
             LEFT JOIN campaigns c_1 ON c_1.org_id = e.org_id AND c_1.id = e.campaign_id
             LEFT JOIN managers m ON m.org_id = c_1.org_id AND m.id = c_1.manager_id
          WHERE e.processed_at IS NULL AND e.scheduled_for <= org_today() AND e.deleted_at IS NULL
        UNION ALL
         SELECT o.id,
            'receipt_text_missing'::text,
            'receipt_text_missing'::text,
            o.id::text AS id,
            NULL::text,
            NULL::text,
            NULL::numeric,
            o.created_at,
            'Set the Hebrew and English receipt text in Settings → Receipt Text. Until then receipts leave those sections out'::text
           FROM organizations o
          WHERE o.id = current_org_id() AND NOT (EXISTS ( SELECT 1
                   FROM receipt_templates t
                  WHERE t.org_id = o.id AND t.level = 'default'::text AND (t.hebrew_text IS NOT NULL OR t.english_text IS NOT NULL)))
        UNION ALL
         SELECT r.org_id,
            'receipt_reissue:'::text || r.id,
            'receipt_reissue'::text,
            r.id,
            r.campaign_id,
            m.full_name,
            r.amount,
            r.voided_at,
            ((r.receipt_number || ' for '::text) || COALESCE(r.donor_name, 'a donor'::text)) || ' was voided because the donation changed'::text
           FROM receipts r
             LEFT JOIN campaigns c_1 ON c_1.org_id = r.org_id AND c_1.id = r.campaign_id
             LEFT JOIN managers m ON m.org_id = c_1.org_id AND m.id = c_1.manager_id
          WHERE r.needs_reissue AND r.status = 'voided'::text AND NOT (EXISTS ( SELECT 1
                   FROM receipts x
                  WHERE x.org_id = r.org_id AND x.donation_ids && r.donation_ids AND x.status = 'issued'::text))
        UNION ALL
         SELECT c_1.org_id,
            'import_conflict:'::text || c_1.id,
            'import_conflict'::text,
            c_1.id,
            i_1.campaign_id,
            NULL::text,
            NULL::numeric,
            i_1.imported_at,
            ((COALESCE(c_1.on_file ->> 'name'::text, 'A donor'::text) || ': the contact list has different details (matched by '::text) || c_1.matched_by) || ')'::text
           FROM import_conflicts c_1
             JOIN imports i_1 ON i_1.org_id = c_1.org_id AND i_1.id = c_1.import_id
          WHERE c_1.resolved_at IS NULL AND i_1.reversed_at IS NULL
        UNION ALL
         SELECT g.org_id,
            'delivery_failed:'::text || g.id,
            'delivery_failed'::text,
            g.id::text AS id,
            g.campaign_id,
            NULL::text,
            NULL::numeric,
            COALESCE(g.failed_at, g.created_at) AS "coalesce",
            (((((initcap(replace(g.kind, '_'::text, ' '::text)) || ' by '::text) ||
                CASE g.channel
                    WHEN 'sms'::text THEN 'text'::text
                    ELSE 'email'::text
                END) || ' to '::text) || COALESCE(((g.to_name || ' ('::text) || g.to_address) || ')'::text, g.to_address)) || ': '::text) || COALESCE(g.error, 'failed'::text)
           FROM messages g
          WHERE g.status = 'failed'::text AND g.resent_as IS NULL
        UNION ALL
         SELECT t.org_id,
            t.task_key,
            t.task_type,
            t.record_id,
            t.campaign_id,
            NULL::text,
            t.amount,
            t.created_at,
            t.summary
           FROM task_items t
          WHERE t.resolved_at IS NULL
        )
 SELECT i.task_key,
    i.task_type,
    i.record_id,
    i.campaign_id,
    c.internal_name AS campaign_name,
    i.fundraiser,
    i.amount,
    i.submitted_at,
    i.summary,
    h.note AS held_note,
    h.task_key IS NOT NULL AS held
   FROM items i
     LEFT JOIN campaigns c ON c.org_id = i.org_id AND c.id = i.campaign_id
     LEFT JOIN LATERAL ( SELECT a.task_key,
            a.note
           FROM task_sheet_actions a
          WHERE a.org_id = i.org_id AND a.task_key = i.task_key AND a.action = 'held'::text
          ORDER BY a.created_at DESC
         LIMIT 1) h ON true
  WHERE ( SELECT is_admin() AS is_admin) AND NOT (EXISTS ( SELECT 1
           FROM task_sheet_actions a
          WHERE a.org_id = i.org_id AND a.task_key = i.task_key AND a.action = 'dismissed'::text));
