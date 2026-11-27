import { useEffect, useState } from 'react';
import { STATE_CENTERS, readRegion, type Region } from '../../supabase/functions/_shared/azureMaps';
import { supabase } from '../lib/supabase';

/** The organization setting for address suggestions' region (Shulim, 2026-11-25). */
export const ADDRESS_REGION_SETTING = 'address_region';
type Mode = 'off' | Region['mode'];

/** "NY, nj ct" into the known two-letter states, and the ones it doesn't know. */
export function parseStates(text: string): { states: string[]; unknown: string[] } {
  const words = text.split(/[\s,;/]+/).map(w => w.trim().toUpperCase()).filter(Boolean);
  return { states: [...new Set(words.filter(w => w in STATE_CENTERS))], unknown: words.filter(w => !(w in STATE_CENTERS)) };
}

/**
 * Organization settings: where address suggestions come from. Off (anywhere in the US), show the chosen states first,
 * or show only the chosen states. Saved when Save is pressed.
 */
export default function AddressRegionSetting({ orgId }: { orgId: string }) {
  const [mode, setMode] = useState<Mode>('off');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void supabase.from('settings').select('value').eq('key', ADDRESS_REGION_SETTING).maybeSingle().then(({ data }) => {
      const r = readRegion(data?.value);
      setMode(r?.mode ?? 'off');
      setText(r?.states.join(', ') ?? '');
    });
  }, [orgId]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null); setSaved(false);
    const { states, unknown } = parseStates(text);
    if (mode !== 'off') {
      if (unknown.length) return setError(`Not a state: ${unknown.join(', ')}. Use two-letter states, for example NY, NJ.`);
      if (!states.length) return setError('Name at least one state, for example NY.');
    }
    setBusy(true);
    const value = mode === 'off' ? { mode: 'off', states } : { mode, states };
    const { error: err } = await supabase.from('settings').upsert({ org_id: orgId, key: ADDRESS_REGION_SETTING, value }, { onConflict: 'org_id,key' });
    setBusy(false);
    if (err) return setError(err.message);
    setText(states.join(', '));
    setSaved(true);
  }

  return (
    <form className="settings-section card" onSubmit={save}>
      <h3>Address suggestions</h3>
      <p className="muted small">Where the suggestions under a donor's street come from: anywhere in the US, or your own state or region first,
        or only there.</p>
      <div className="fields two">
        <label className="field"><span>Region</span>
          <select value={mode} onChange={e => { setMode(e.target.value as Mode); setSaved(false); }}>
            <option value="off">Anywhere in the US</option>
            <option value="prefer">Show these states first</option>
            <option value="only">Only these states</option>
          </select>
        </label>
        <label className="field"><span>States</span>
          <input value={text} onChange={e => { setText(e.target.value); setSaved(false); }} placeholder="NY, NJ, CT" disabled={mode === 'off'} />
        </label>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="form-actions">
        {saved && <span className="muted small">Saved.</span>}
        <div className="spacer" />
        <button className="btn" disabled={busy}>{busy ? 'Saving…' : 'Save address suggestions'}</button>
      </div>
    </form>
  );
}
