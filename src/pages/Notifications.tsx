import { useEffect, useState } from 'react';
import { useAuth } from '../lib/auth';
import { campaignOptions, type Option } from '../lib/lookups';
import { supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';

// Each person's own notification choices. Admins choose which alerts and digests they get; fundraisers
// always get their campaigns' donation alerts and choose only how things reach them.

type Channel = 'email' | 'sms' | 'both';
const CHANNELS: [Channel, string][] = [['email', 'Email'], ['sms', 'Text'], ['both', 'Email and text']];

const ADMIN_KINDS: [string, string][] = [['donations', 'Donation alerts'], ['tasks', 'Task Sheet alerts'], ['messages', 'Fundraiser messages'], ['digests', 'Digests']];
const FUNDRAISER_KINDS: [string, string][] = [
  ['donations', 'Donations to my campaigns'], ['messages', 'Messages from the office'], ['machine_digest', 'Nightly machine summary'], ['reminders', 'Tasks due today'],
  ['payouts', 'Payout request decisions'], ['requests', 'Campaign and team request decisions'], ['bookings', 'Machine bookings'],
];

function ChannelPick({ value, onChange }: { value: Channel; onChange: (c: Channel) => void }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value as Channel)}>
      {CHANNELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
}

export default function NotificationsPage() {
  const { isAdmin } = useAuth();
  const [version, setVersion] = useState(0);
  const q = useQuery(async () => (await supabase.from('notification_preferences').select('*').maybeSingle()).data as Row | null, [version]);
  const [campaigns, setCampaigns] = useState<Option[]>([]);
  const [f, setF] = useState({
    phone: '', donation_alerts: 'off', donation_min: '', donation_campaigns: [] as string[], donation_digest: 'off',
    task_alerts: 'both', payout_alerts: 'immediate', weekly_digests: true, message_alerts: 'immediate', channels: {} as Record<string, Channel>,
  });
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (isAdmin) campaignOptions().then(setCampaigns); }, [isAdmin]);
  useEffect(() => {
    const p = q.data as Row | null | undefined;
    if (p === undefined) return;
    setF({
      phone: p?.phone ?? '', donation_alerts: p?.donation_alerts ?? 'off', donation_min: p?.donation_min != null ? String(p.donation_min) : '',
      donation_campaigns: p?.donation_campaigns ?? [], donation_digest: p?.donation_digest ?? 'off', task_alerts: p?.task_alerts ?? 'both',
      payout_alerts: p?.payout_alerts ?? 'immediate', weekly_digests: p?.weekly_digests ?? true, message_alerts: p?.message_alerts ?? 'immediate', channels: p?.channels ?? {},
    });
  }, [q.data]);

  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => { setSaved(false); setF(x => ({ ...x, [k]: v })); };
  const channel = (k: string) => f.channels[k] ?? 'email';
  async function save() {
    setError(null);
    const { error: e } = await supabase.rpc('save_notification_preferences', {
      p_phone: f.phone, p_donation_alerts: f.donation_alerts, p_donation_min: f.donation_min ? Number(f.donation_min) : null,
      p_donation_campaigns: f.donation_campaigns.length ? f.donation_campaigns : null, p_donation_digest: f.donation_digest,
      p_task_alerts: f.task_alerts, p_payout_alerts: f.payout_alerts, p_weekly_digests: f.weekly_digests, p_channels: f.channels, p_message_alerts: f.message_alerts,
    });
    if (e) return setError(e.message);
    setSaved(true);
    setVersion(v => v + 1);
  }

  const wantsText = Object.values(f.channels).some(c => c !== 'email');
  // One switch for everything (Moshe Henig, 2026-11-12): off means no notification emails or texts at all; the choices
  // below are kept for when it's turned back on.
  const on = (q.data as Row | null | undefined)?.notifications_on !== false;
  const [switchError, setSwitchError] = useState<string | null>(null);
  async function toggle(next: boolean) {
    setSwitchError(null);
    const { error: e } = await supabase.rpc('set_my_notifications', { p_on: next });
    if (e) return setSwitchError(e.message);
    setVersion(v => v + 1);
  }
  return (
    <section className="view">
      <div className="view-head">
        <div className="view-title"><h1>My Notifications</h1><span className="count">What reaches you, and how</span></div>
      </div>

      <div className={`panel-box notify-switch ${on ? '' : 'off'}`}>
        <label className="inline-check"><input type="checkbox" checked={on} disabled={q.loading} onChange={e => void toggle(e.target.checked)} />
          <b>{on ? 'Notifications are on' : 'Notifications are off'}</b></label>
        <p className="muted small">{on
          ? 'Turn this off to stop all notification emails and texts to you. Your choices below are kept.'
          : 'No notification emails or texts reach you. Turn it back on any time; your choices below still apply then.'}</p>
        {switchError && <div className="error">{switchError}</div>}
      </div>

      {isAdmin ? (
        <>
          <div className="panel-box">
            <h2>Donations</h2>
            <div className="fields">
              <label className="field"><span>Alert me</span>
                <select value={f.donation_alerts} onChange={e => set('donation_alerts', e.target.value)}>
                  <option value="off">Never</option><option value="all">For every donation</option><option value="over">For donations of at least…</option>
                </select></label>
              {f.donation_alerts === 'over' && (
                <label className="field"><span>Amount</span><input type="number" min="1" step="1" value={f.donation_min} onChange={e => set('donation_min', e.target.value)} /></label>
              )}
              <label className="field"><span>Digest</span>
                <select value={f.donation_digest} onChange={e => set('donation_digest', e.target.value)}>
                  <option value="off">None</option><option value="daily">Every morning</option><option value="weekly">Sunday mornings</option>
                </select>
                <small className="muted">{f.donation_alerts === 'over' ? 'Totals of the donations under your amount.' : 'Totals by campaign.'}</small></label>
            </div>
            {f.donation_alerts !== 'off' || f.donation_digest !== 'off' ? (
              <>
                <p className="muted small">Campaigns: {f.donation_campaigns.length ? `${f.donation_campaigns.length} chosen` : 'all'}. Tick some to hear only about those.</p>
                <div className="pick-list">
                  {campaigns.map(c => (
                    <label key={c.value} className="inline-check"><input type="checkbox" checked={f.donation_campaigns.includes(c.value)}
                      onChange={e => set('donation_campaigns', e.target.checked ? [...f.donation_campaigns, c.value] : f.donation_campaigns.filter(v => v !== c.value))} /> {c.label}</label>
                  ))}
                </div>
              </>
            ) : null}
          </div>

          <div className="panel-box">
            <h2>Task Sheet, payouts and messages</h2>
            <div className="fields">
              <label className="field"><span>New Task Sheet items</span>
                <select value={f.task_alerts} onChange={e => set('task_alerts', e.target.value)}>
                  <option value="immediate">Right away</option><option value="digest">Morning digest of items waiting a day</option>
                  <option value="both">Both</option><option value="off">Off</option>
                </select></label>
              <label className="field"><span>Payout requests</span>
                <select value={f.payout_alerts} onChange={e => set('payout_alerts', e.target.value)}>
                  <option value="immediate">Right away</option><option value="digest">In the morning digest</option><option value="off">Off</option>
                </select></label>
              <label className="field"><span>Messages from fundraisers</span>
                <select value={f.message_alerts} onChange={e => set('message_alerts', e.target.value)}>
                  <option value="immediate">Right away</option><option value="digest">Morning digest of unread</option><option value="off">Off</option>
                </select></label>
              <label className="inline-check"><input type="checkbox" checked={f.weekly_digests} onChange={e => set('weekly_digests', e.target.checked)} /> Sunday digests of open pledges and vouchers</label>
            </div>
            <p className="muted small">System problems, such as a failed delivery, always reach the Task Sheet whatever you choose here.</p>
          </div>

          <div className="panel-box">
            <h2>How they reach me</h2>
            <div className="fields">
              {ADMIN_KINDS.map(([k, label]) => (
                <label key={k} className="field"><span>{label}</span><ChannelPick value={channel(k)} onChange={c => set('channels', { ...f.channels, [k]: c })} /></label>
              ))}
              <label className="field"><span>My cell for texts</span><input type="tel" value={f.phone} onChange={e => set('phone', e.target.value)} />
                {wantsText && !f.phone.trim() && <small className="muted">Without a number, texts come as emails instead.</small>}</label>
            </div>
          </div>
        </>
      ) : (
        <div className="panel-box">
          <h2>How they reach me</h2>
          <p className="muted small">You always hear about donations to your campaigns, except Donary machine payments, which come in one summary each night.
            Texts go to the phone on your fundraiser record; ask the office to change it.</p>
          <div className="fields">
            {FUNDRAISER_KINDS.map(([k, label]) => (
              <label key={k} className="field"><span>{label}</span><ChannelPick value={channel(k)} onChange={c => set('channels', { ...f.channels, [k]: c })} /></label>
            ))}
          </div>
        </div>
      )}

      {saved && <div className="notice">Saved. Changes take effect right away.</div>}
      {error && <div className="error">{error}</div>}
      <div className="form-actions"><div className="spacer" /><button type="button" className="btn primary" onClick={save}>Save</button></div>
    </section>
  );
}
