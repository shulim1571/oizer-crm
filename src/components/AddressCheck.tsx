import { useEffect, useState } from 'react';
import { requestOrgId, supabase, type Row } from '../lib/supabase';

// Whether this organization has USPS address checks set up (asked once per page load).
let available: Promise<boolean> | null = null;
const uspsAvailable = () => (available ??= Promise.resolve(supabase.rpc('usps_check_allowed')).then(({ error }) => !error, () => false));

/**
 * "Check with USPS" under an address field (Shulim, 2026-11-12): sends what's typed to USPS's address API through the
 * usps-address function and shows the standardized address; "Use this" puts it in the field. Nothing is saved until
 * the form is. Shown only once the organization has its own USPS keys.
 */
export default function AddressCheck({ value, oneLine, onUse }: { value: unknown; oneLine: boolean; onUse: (v: string) => void }) {
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Row | null>(null);
  useEffect(() => { void uspsAvailable().then(setOn); }, []);
  useEffect(() => setResult(null), [value]);
  if (!on) return null;
  const text = String(value ?? '').trim();
  async function check(e: React.MouseEvent) {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    const { data, error } = await supabase.functions.invoke('usps-address', { body: { org: requestOrgId(), address: text } });
    setBusy(false);
    setResult(error ? { error: 'The address check didn\'t answer. Try again in a moment.' } : (data as Row));
  }
  const suggestion = result && !result.error ? String(oneLine ? result.formatted_one_line : result.formatted) : null;
  return (
    <span className="address-check" onClick={e => e.stopPropagation()}>
      <button type="button" className="link" disabled={!text || busy} onClick={check}>{busy ? 'Checking with USPS…' : 'Check with USPS'}</button>
      {result?.error && <span className="error-text small"> {String(result.error)}</span>}
      {suggestion && (
        <span className="address-suggestion">
          {suggestion === text ? <span className="muted small">USPS has it exactly like this.</span> : (
            <>
              <span className="small">USPS: <b style={{ whiteSpace: 'pre-line' }}>{suggestion}</b></span>
              <button type="button" className="btn small" onClick={e => { e.preventDefault(); onUse(suggestion); }}>Use this</button>
            </>
          )}
          {result?.deliverable && <span className="muted small"> {String(result.deliverable)}</span>}
        </span>
      )}
    </span>
  );
}
