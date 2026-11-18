-- Moshe, 2026-11-18: "It should only differ the fee if the method was edited but otherwise even editing other
-- fields in a transaction should not update the fee to what it's set now, just stay put as when the transaction
-- came in". Editing a donation's amount, campaign or anything else keeps its saved fee (net follows the new amount);
-- only a changed payment method works the fee out again. Unchanged: a manual fee is never overwritten (clearing it
-- brings back the method's preset), a fee set in the same edit is kept, card-processor and Donary fees are kept,
-- moving gifts with a method alias keeps their fee, and a failed charge later completed still gets its fee (#59:
-- failed charges are saved with no fee).
do $$
declare v_def text; v_new text;
begin
  select pg_get_functiondef('public.donation_defaults'::regproc) into v_def;
  v_new := replace(v_def,
    $s$          and (new.amount is distinct from old.amount or new.payment_method is distinct from old.payment_method
               or new.campaign_id is distinct from old.campaign_id or (old.status = 'failed' and new.status <> 'failed')) then$s$,
    $s$          and (new.payment_method is distinct from old.payment_method or (old.status = 'failed' and new.status <> 'failed')) then$s$);
  if v_new = v_def then raise exception 'donation_defaults: fee condition not found'; end if;
  v_def := v_new;
  v_new := replace(v_def,
    $s$    -- Readiness #1 (2026-11-15): a changed amount, method or campaign brings the fee rule's fee again, unless a manual$s$,
    $s$    -- Moshe, 2026-11-18 (was readiness #1): only a changed payment method brings the fee rule's fee again, unless a manual$s$);
  if v_new = v_def then raise exception 'donation_defaults: comment not found'; end if;
  execute v_new;
end $$;
