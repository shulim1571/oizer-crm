import { useQuery } from '../lib/useQuery';
import { money } from '../lib/format';
import { supabase, type Row } from '../lib/supabase';

/** The chosen campaign's balance right now, shown on the payout form as soon as a campaign is picked. */
export default function CampaignBalanceNote({ campaignId, amount }: { campaignId: string | null | undefined; amount?: unknown }) {
  const q = useQuery(async () => {
    if (!campaignId) return null;
    const { data } = await supabase.from('campaign_summary').select('id, internal_name, balance, balance_mode, pending_balance').eq('id', campaignId).maybeSingle();
    return data as Row | null;
  }, [campaignId], { live: ['gifts', 'payouts', 'transfers', 'campaigns'] });
  const avail = useAvailable(campaignId);
  const c = q.data as Row | null | undefined;
  if (!campaignId || !c) return null;
  const balance = Number(c.balance ?? 0);
  const after = Number(amount) > 0 ? balance - Number(amount) : null;
  return (
    <div className={`balance-note ${balance < 0 ? 'neg' : ''}`} role="status">
      <span>Campaign {c.id} balance now: <b>{c.balance_mode === 'shared' ? 'shared with its parent' : money(balance)}</b></span>
      {Number(c.pending_balance) > 0 && <span className="muted small"> · {money(c.pending_balance)} pending, not in the balance</span>}
      {after !== null && c.balance_mode !== 'shared' && <span className={after < 0 ? 'neg-text' : 'muted small'}> · after this payout: {money(after)}</span>}
      {avail && c.balance_mode !== 'shared' && <AvailableLine a={avail} />}
    </div>
  );
}

/**
 * Available to pay out (readiness #19, display only): the balance less card gifts the processor hasn't paid out yet
 * (the organization's card hold) and recent checks the bank hasn't cleared. It doesn't stop a payout.
 */
export function useAvailable(campaignId: string | null | undefined) {
  const q = useQuery(async () => {
    if (!campaignId) return null;
    const { data } = await supabase.rpc('campaign_available', { p_campaign: campaignId });
    return ((data ?? []) as Row[])[0] ?? null;
  }, [campaignId], { live: ['gifts', 'payouts', 'transfers', 'campaigns'] });
  return q.data as Row | null | undefined;
}

export const availableNote = (a: Row) => {
  const parts = [
    Number(a.card_hold) > 0 ? `${money(a.card_hold)} in card gifts from the last ${a.hold_days} day${Number(a.hold_days) === 1 ? '' : 's'}, not paid out by the processor yet` : '',
    Number(a.checks_uncleared) > 0 ? `${money(a.checks_uncleared)} in checks from the last 30 days the bank hasn't cleared yet` : '',
  ].filter(Boolean);
  return parts.length ? `The balance less ${parts.join(' and ')}.` : 'The whole balance: nothing is waiting on the processor or the bank.';
};

export function AvailableLine({ a }: { a: Row }) {
  return (
    <span className="muted small" title={availableNote(a)}> · available to pay out: <b>{money(a.available)}</b> <span className="available-why">({availableNote(a)})</span></span>
  );
}
