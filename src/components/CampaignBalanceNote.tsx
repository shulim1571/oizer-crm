import { useQuery } from '../lib/useQuery';
import { money } from '../lib/format';
import { supabase, type Row } from '../lib/supabase';

/** The chosen campaign's balance right now, shown on the payout form as soon as a campaign is picked. */
export default function CampaignBalanceNote({ campaignId, amount }: { campaignId: string | null | undefined; amount?: unknown }) {
  const q = useQuery(async () => {
    if (!campaignId) return null;
    const { data } = await supabase.from('campaign_summary').select('id, internal_name, balance, balance_mode, pending_balance').eq('id', campaignId).maybeSingle();
    return data as Row | null;
  }, [campaignId]);
  const c = q.data as Row | null | undefined;
  if (!campaignId || !c) return null;
  const balance = Number(c.balance ?? 0);
  const after = Number(amount) > 0 ? balance - Number(amount) : null;
  return (
    <div className={`balance-note ${balance < 0 ? 'neg' : ''}`} role="status">
      <span>Campaign {c.id} balance now: <b>{c.balance_mode === 'shared' ? 'shared with its parent' : money(balance)}</b></span>
      {Number(c.pending_balance) > 0 && <span className="muted small"> · {money(c.pending_balance)} pending, not in the balance</span>}
      {after !== null && c.balance_mode !== 'shared' && <span className={after < 0 ? 'neg-text' : 'muted small'}> · after this payout: {money(after)}</span>}
    </div>
  );
}
