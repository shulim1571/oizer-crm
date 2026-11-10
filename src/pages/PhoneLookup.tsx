import { useEffect, useState } from 'react';
import { Phone } from 'lucide-react';
import { Pill } from '../components/Pill';
import { useAuth } from '../lib/auth';
import { dateTime } from '../lib/format';
import { supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';

// Campaign lookup by text and by phone. Replies and calls cost money at Twilio, so each is switched on here.

const OUTCOME: Record<string, { tone: 'green' | 'amber' | 'red' | 'blue' | ''; text: string }> = {
  answered: { tone: 'green', text: 'Answered' }, list: { tone: 'green', text: 'Listed campaigns' },
  needs_pin: { tone: 'blue', text: 'Asked for PIN' }, wrong_pin: { tone: 'amber', text: 'Wrong PIN' },
  locked: { tone: 'red', text: 'Locked out' }, not_found: { tone: 'amber', text: 'No such campaign' }, help: { tone: '', text: 'Sent help' },
  recent: { tone: 'green', text: 'Recent transactions' }, recent_limited: { tone: 'red', text: 'Too many RECENT' },
  recent_unknown: { tone: 'amber', text: 'RECENT from unknown phone' },
};

export default function PhoneLookupPage() {
  const { isSuperAdmin } = useAuth();
  const status = useQuery(async () => (((await supabase.rpc('phone_lookup_status')).data ?? []) as Row[])[0] ?? null, []);
  const recent = useQuery(async () => {
    const { data, error } = await supabase.rpc('recent_phone_lookups');
    if (error) throw new Error(error.message);
    return data as Row[];
  });
  const [v, setV] = useState({ sms: false, voice: false, noDonary: false });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const s = status.data as Row | null | undefined;
  useEffect(() => { if (s) setV({ sms: s.sms_replies, voice: s.voice, noDonary: !!s.exclude_donary }); }, [s]);
  const voiceUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/voice`;
  const smsUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/message-events?provider=twilio`;

  async function save() {
    setMsg(null);
    const { error } = await supabase.rpc('save_phone_lookup', { p_sms_replies: v.sms, p_voice: v.voice, p_exclude_donary: v.noDonary });
    setMsg(error ? { ok: false, text: error.message } : { ok: true, text: 'Saved.' });
    status.reload();
  }

  return (
    <section className="view">
      <div className="view-head">
        <div className="view-title"><h1>Phone &amp; Text Lookup</h1><span className="count">Campaign balances by text message or phone call</span></div>
      </div>
      {msg && <div className={msg.ok ? 'notice' : 'error'}>{msg.text}</div>}

      <div className="panel-box">
        <h2><Phone size={16} /> {s?.sms_number ?? 'No number yet'} {s?.sms_replies ? <Pill tone="green">Texts on</Pill> : <Pill>Texts off</Pill>}
          {s?.voice ? <Pill tone="green">Phone line on</Pill> : <Pill>Phone line off</Pill>}</h2>
        <p className="muted small">
          Fundraisers texting or calling from a registered phone (set on each fundraiser’s page) hear their own campaigns.
          Anyone else gives the campaign number and its PIN (set on the campaign). Five wrong PINs in an hour lock that phone out for the hour.
        </p>
        <ul className="muted small">
          <li>Text <code>BAL</code> for your campaigns, <code>1001</code> for one of them, or <code>1001 1234</code> with a PIN. <code>MENU</code> explains.</li>
          <li>Admins and fundraisers can text <code>RECENT</code> for their last 5 transactions, or <code>RECENT 1001</code> for one campaign: date, amount, campaign and the donor’s name (Anon for anonymous gifts). Admins are matched by the phone on their notification settings, fundraisers by a registered phone. Up to 10 an hour per phone; an unknown phone gets one reply a day saying it isn’t registered.</li>
          <li>Call and enter the campaign number, then the PIN; fundraisers can press star for all their campaigns.</li>
        </ul>
        {isSuperAdmin ? (
          <>
            <label className="check"><input type="checkbox" checked={v.sms} onChange={e => setV({ ...v, sms: e.target.checked })} /> Answer lookup texts</label>
            <p className="muted small">Each answer is a text Twilio bills (about $0.008 per part plus carrier fees; Hebrew and Yiddish names make shorter parts). Only messages that ask for a lookup get an answer.</p>
            <label className="check"><input type="checkbox" checked={v.voice} onChange={e => setV({ ...v, voice: e.target.checked })} /> Answer the phone line</label>
            <p className="muted small">Twilio bills incoming calls by the minute (about $0.0085 a minute for a local number). While this is off, calls are turned away without charge.</p>
            <label className="check"><input type="checkbox" checked={v.noDonary} onChange={e => setV({ ...v, noDonary: e.target.checked })} /> Leave out Donary donations</label>
            <p className="muted small">Off by default. When on, text and phone replies (balances, campaign lookups and RECENT) don’t count or list donations that came from Donary. The portal itself still shows everything.</p>
            <div className="form-actions"><div className="spacer" /><button className="btn primary" onClick={save}>Save</button></div>
          </>
        ) : <p className="muted small">Only the Super Admin can turn these on or off.</p>}
      </div>

      <details className="help">
        <summary>Twilio setup for {s?.sms_number ?? 'the number'}</summary>
        <p className="muted small">In Twilio, under the number’s settings (both HTTP POST):</p>
        <ul className="muted small">
          <li>A message comes in: <code>{smsUrl}</code> (already in place for STOP and START)</li>
          <li>A call comes in: <code>{voiceUrl}</code></li>
        </ul>
      </details>

      <h2>Recent lookups</h2>
      <div className="table-card"><div className="table-wrap">
        <table className="grid">
          <thead><tr><th>When</th><th>By</th><th>From</th><th>Fundraiser</th><th>Campaign</th><th>Result</th></tr></thead>
          <tbody>
            {(recent.data ?? []).length === 0 && <tr><td colSpan={6} className="muted">None yet.</td></tr>}
            {(recent.data ?? []).map((r, i) => (
              <tr key={i}>
                <td>{dateTime(r.at)}</td><td>{r.channel === 'sms' ? 'Text' : 'Call'}</td><td>{r.from_phone}</td>
                <td>{r.fundraiser ?? <span className="muted">—</span>}</td><td>{r.campaign_id ?? ''}</td>
                <td><Pill tone={OUTCOME[r.outcome]?.tone ?? ''}>{OUTCOME[r.outcome]?.text ?? r.outcome}</Pill></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div></div>
    </section>
  );
}

/** Registered phones on a fundraiser's page. */
export function FundraiserPhones({ managerId }: { managerId: string }) {
  const { isAdmin } = useAuth();
  const list = useQuery(async () => (((await supabase.rpc('fundraiser_phone_list', { p_manager: managerId })).data ?? []) as Row[]), [managerId]);
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | null>(null);
  if (!isAdmin) return null;
  async function add() {
    setError(null);
    const { error: e } = await supabase.rpc('add_fundraiser_phone', { p_manager: managerId, p_phone: phone });
    if (e) return setError(e.message);
    setPhone('');
    list.reload();
  }
  async function remove(p: string) {
    if (!confirm(`Stop recognizing ${p} for this fundraiser?`)) return;
    await supabase.rpc('remove_fundraiser_phone', { p_manager: managerId, p_phone: p });
    list.reload();
  }
  return (
    <div className="panel-box">
      <h2><Phone size={16} /> Registered phones</h2>
      <p className="muted small">Texts and calls from these phones (and the phone on this fundraiser’s record) hear this fundraiser’s campaigns without a PIN.</p>
      {((list.data as Row[] | undefined) ?? []).map(r => (
        <div key={r.phone} className="multi"><code>{r.phone}</code><span className="muted small">added {dateTime(r.added_at)} by {r.added_by}</span>
          <button className="btn" onClick={() => remove(r.phone)}>Remove</button></div>
      ))}
      <div className="multi">
        <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="(718) 555-0101" inputMode="tel" />
        <button className="btn" disabled={!phone.trim()} onClick={add}>Add phone</button>
      </div>
      {error && <div className="error">{error}</div>}
    </div>
  );
}
