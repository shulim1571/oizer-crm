import { useAuth } from '../lib/auth';
import { dateTime } from '../lib/format';
import { fetchAll, supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';

const OVERRIDES: [string, string][] = [
  ['enter_manual_payments', 'Enter manual payments (held until an admin approves)'],
  ['view_donors_beyond', 'View donors beyond their own campaigns'],
  ['request_payouts', 'Request payouts'],
  ['payout_visibility', 'See full payout details'],
  ['view_fee_breakdown', 'View campaign fee breakdown'],
  ['source_reports', 'Source reports beyond their own campaigns'],
  ['bulk_receipts', 'Generate and download receipts in bulk'],
  ['custom_fields', 'Add custom fields to the payment page'],
];

/** Suspend, reinstate or deactivate a fundraiser, and manage their permission overrides. */
export default function FundraiserControls({ manager, onChange }: { manager: Row; onChange: () => void }) {
  const { permissions } = useAuth();
  const canGrant = permissions.includes('grant_overrides');

  const overrides = useQuery(async () => {
    const { data, error } = await supabase.from('fundraiser_overrides').select('*').eq('manager_id', manager.id).is('revoked_at', null);
    if (error) throw new Error(error.message);
    return data as Row[];
  }, [manager.id]);

  const campaigns = useQuery(
    () => fetchAll((a, b) => supabase.from('campaigns').select('id, internal_name')
      .or(`manager_id.eq.${manager.id},sub_manager_ids.cs.{${manager.id}}`).order('id').range(a, b)),
    [manager.id],
  );

  async function setStatus(status: string, question: string) {
    const reason = prompt(question);
    if (reason === null) return;
    const { error } = await supabase.rpc('set_fundraiser_status', { p_manager: manager.id, p_status: status, p_reason: reason || null });
    if (error) return alert(error.message);
    onChange();
  }

  async function toggle(permission: string, on: boolean) {
    const { error } = on
      ? await supabase.rpc('grant_override', { p_manager: manager.id, p_permission: permission, p_campaigns: null })
      : await supabase.rpc('revoke_override', { p_manager: manager.id, p_permission: permission });
    if (error) alert(error.message);
    overrides.reload();
  }

  async function setScope(o: Row, campaignIds: string[]) {
    const { error } = await supabase.rpc('grant_override', {
      p_manager: manager.id, p_permission: o.permission, p_campaigns: campaignIds.length ? campaignIds : null,
    });
    if (error) alert(error.message);
    overrides.reload();
  }

  return (
    <div className="fundraiser-controls">
      <div className="multi">
        {manager.status === 'active' && (
          <>
            <button className="btn" onClick={() => setStatus('suspended', 'Suspend this fundraiser? They lose access at once; their campaigns keep running. Reason (optional):')}>Suspend</button>
            <button className="btn danger" onClick={() => setStatus('deactivated', 'Deactivate this fundraiser? Use this when they have left. Reason (optional):')}>Deactivate</button>
          </>
        )}
        {manager.status !== 'active' && (
          <button className="btn" onClick={() => setStatus('active', 'Restore this fundraiser\'s access? Note (optional):')}>Reinstate</button>
        )}
        {manager.status_at && <span className="muted small">{manager.status === 'active' ? 'Reinstated' : 'Changed'} by {manager.status_by}, {dateTime(manager.status_at)}</span>}
      </div>
      <details>
        <summary>Permission overrides ({overrides.data?.length ?? 0})</summary>
        <p className="muted small">Extra permissions for this fundraiser only. Each stays dormant until the feature it applies to is built.</p>
        {OVERRIDES.map(([key, label]) => {
          const active = overrides.data?.find(o => o.permission === key);
          return (
            <div key={key} className="override">
              <label>
                <input type="checkbox" checked={!!active} disabled={!canGrant && !active} onChange={e => toggle(key, e.target.checked)} /> {label}
              </label>
              {active && (
                <>
                  <select multiple size={Math.min(3, campaigns.data?.length || 1)} disabled={!canGrant} value={active.campaign_ids ?? []}
                          title="Hold Ctrl to choose several. None chosen means all their campaigns."
                          onChange={e => setScope(active, [...e.target.selectedOptions].map(x => x.value))}>
                    {(campaigns.data ?? []).map(c => <option key={c.id} value={c.id}>{c.id} - {c.internal_name}</option>)}
                  </select>
                  <span className="muted small">
                    {active.campaign_ids ? 'Chosen campaigns' : 'All their campaigns'} · granted by {active.granted_by}, {dateTime(active.granted_at)}
                  </span>
                </>
              )}
            </div>
          );
        })}
      </details>
    </div>
  );
}
