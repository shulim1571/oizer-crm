-- Text lookup, forgiving (after Shulim's first tries on 2026-11-09): people type "1002#", "Balance, 1002, 2468",
-- "1002# 2468#" or "10022468". Now:
--   * #, *, commas and other punctuation are ignored, and an optional leading BAL / BALANCE / B is accepted;
--   * "10022468" is read as campaign 1002 and PIN 2468 when it starts with a real campaign number and the rest is 4–8 digits;
--   * anything that looks like a lookup (it has digits, or starts with the keyword) always gets a helpful reply;
--     a code with a missing or garbled PIN gets "Text 1002 and its PIN, like: 1002 1234";
--   * a registered phone with no active campaigns is told how to look one up by number and PIN.
-- STOP / START / HELP stay with Twilio, and messages with no digits and no keyword still get no reply.

create or replace function public.sms_lookup_reply(p_to text, p_from text, p_body text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  o record;
  v_raw text := upper(trim(coalesce(p_body, '')));
  v_body text;
  v_keyword boolean := false;
  v_digits text[];
  v_words text[];
  v_campaign text;
  v_pin text;
  v_pin_bad boolean := false;
  r jsonb;
  v_line text;
  x jsonb;
  v_help text := 'Text a campaign number and its PIN, like: 1001 1234. Fundraisers texting from a registered phone can text BAL.';
begin
  select * into o from public.phone_org(p_to);
  if o.org_id is null or not o.sms_replies then return null; end if;
  if v_raw in ('STOP','STOPALL','UNSUBSCRIBE','CANCEL','END','QUIT','REVOKE','OPTOUT','START','UNSTOP','YES','HELP','INFO') then return null; end if;

  -- Punctuation out, spaces tidied.
  v_body := trim(regexp_replace(regexp_replace(v_raw, '[^A-Z0-9 ]+', ' ', 'g'), '\s+', ' ', 'g'));
  if v_body in ('MENU', '') and v_raw ~ '^(MENU|\?+)$' then return o.org_name || ': ' || v_help; end if;
  if v_body ~ '^(BAL|BALANCE|BALANCES|B)( |$)' then
    v_keyword := true;
    v_body := trim(regexp_replace(v_body, '^(BAL|BALANCE|BALANCES|B)( |$)', ''));
  end if;

  v_digits := array(select m[1] from regexp_matches(v_body, '(\d+)', 'g') m);
  v_words := array(select w from unnest(string_to_array(v_body, ' ')) w where w <> '' and w !~ '^\d+$');

  -- No digits: the keyword alone lists a registered phone's campaigns; anything else isn't for us.
  if cardinality(v_digits) = 0 then
    if not v_keyword then return null; end if;
    r := public.phone_lookup(o.org_id, 'sms', p_from, null, null);
  else
    v_campaign := v_digits[1];
    if cardinality(v_digits) >= 2 then
      v_pin := v_digits[2];
      v_pin_bad := cardinality(v_digits) > 2 or v_pin !~ '^\d{4,8}$';
    elsif not exists (select 1 from public.campaigns c where c.org_id = o.org_id and c.id = v_campaign and c.deleted_at is null) then
      -- "10022468": a real campaign number with the PIN run on.
      select c.id, substr(v_campaign, length(c.id) + 1) into v_campaign, v_pin
      from public.campaigns c
      where c.org_id = o.org_id and c.deleted_at is null and c.id ~ '^\d+$'
        and v_digits[1] like c.id || '%' and length(v_digits[1]) - length(c.id) between 4 and 8
      order by length(c.id) desc limit 1;
      v_campaign := coalesce(v_campaign, v_digits[1]);
    end if;
    -- Letters mixed into the code or PIN ("1002 24x8") make the PIN unreadable.
    if cardinality(v_words) > 0 and v_pin is not null then v_pin_bad := true; end if;
    if length(v_campaign) > 10 then
      return 'No campaign with that number. ' || v_help;
    end if;
    r := public.phone_lookup(o.org_id, 'sms', p_from, v_campaign, case when v_pin_bad then null else v_pin end);
  end if;

  case r->>'outcome'
    when 'answered' then
      x := r->'campaign';
      return format('%s %s: Raised %s, Expenses %s, Balance %s%s.', x->>'id', x->>'name', public.phone_money((x->>'raised')::numeric),
        public.phone_money((x->>'expenses')::numeric), public.phone_money((x->>'balance')::numeric),
        case when (x->>'pending')::numeric <> 0 then ', Pending ' || public.phone_money((x->>'pending')::numeric) else '' end);
    when 'list' then
      if jsonb_array_length(r->'campaigns') = 0 then
        return 'No active campaigns for this phone. To look one up, text its number and PIN, like: 1001 1234';
      end if;
      select string_agg(format('%s %s: %s', e->>'id', e->>'name', public.phone_money((e->>'balance')::numeric)), E'\n') into v_line
      from jsonb_array_elements(r->'campaigns') e;
      return v_line || E'\nText a number for details.';
    when 'needs_pin' then return format('Text %s and its PIN, like: %s 1234', r->>'campaign_id', r->>'campaign_id');
    when 'wrong_pin' then return format('That PIN doesn''t match campaign %s. Check it and text: %s and the PIN', v_campaign, v_campaign);
    when 'locked' then return 'Too many wrong PINs from this phone. Try again in an hour.';
    when 'not_found' then return 'No campaign with that number. ' || v_help;
    else return o.org_name || ': ' || v_help;
  end case;
end $$;

revoke execute on function public.sms_lookup_reply(text, text, text) from public, anon, authenticated;
grant execute on function public.sms_lookup_reply(text, text, text) to service_role;
