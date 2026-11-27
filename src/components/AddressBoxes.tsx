import { useEffect, useRef, useState } from 'react';
import { joinAddress, splitAddress, type AddressFields } from '../lib/addressParts';
import AddressSuggest from './AddressSuggest';

/**
 * A US address in separate boxes (Shulim, 2026-11-25): Street (with suggestions while typing), Apt / Suite, City,
 * State and ZIP. Picking a suggestion fills the street, city, state and ZIP. What's kept is still the one address
 * field ("123 Main St Apt 4" then "Brooklyn NY 11219"), so receipts, exports and the feeds read it as before; an
 * address that doesn't read as a US address opens with all of it in Street.
 */
/** The boxes' labels: English on the office's forms; the payment page passes its own language's. */
export interface AddressLabels { street: string; unit: string; city: string; state: string; zip: string }
const ENGLISH: AddressLabels = { street: 'Street', unit: 'Apt / Suite', city: 'City', state: 'State', zip: 'ZIP' };

export default function AddressBoxes({ value, onChange, suggest = true, campaign, labels = ENGLISH, zipRequired = false }: {
  value: string | null | undefined;
  onChange: (joined: string, parts: AddressFields) => void;
  /** Address suggestions in the Street box (off where suggestions don't apply). */
  suggest?: boolean;
  /** On a campaign's public payment page: that campaign, for its suggestions (Moshe, 2026-11-25). */
  campaign?: string;
  labels?: AddressLabels;
  zipRequired?: boolean;
}) {
  const [a, setA] = useState<AddressFields>(() => splitAddress(value));
  // The last address handed up, so a change from outside (not from these boxes) re-reads the boxes.
  const sent = useRef<string>(joinAddress(a));
  useEffect(() => {
    const v = String(value ?? '');
    if (v !== sent.current) { const next = splitAddress(v); setA(next); sent.current = joinAddress(next); }
  }, [value]);
  const update = (patch: Partial<AddressFields>) => {
    const next = { ...a, ...patch };
    setA(next);
    sent.current = joinAddress(next);
    onChange(sent.current, next);
  };
  const box = (k: keyof AddressFields) => (e: { target: { value: string } }) => update({ [k]: k === 'state' ? e.target.value.toUpperCase() : e.target.value });
  return (
    <div className="fields two address-boxes">
      <label className="field wide"><span dir="auto">{labels.street}</span>
        {suggest
          ? <AddressSuggest value={a.street} onChange={v => update({ street: v })} placeholder="123 Main St" campaign={campaign}
              onPick={s => update({ street: s.street, city: s.city, state: s.state, zip: s.zip })} />
          : <input value={a.street} onChange={box('street')} autoComplete="off" placeholder="123 Main St" />}
      </label>
      <label className="field"><span dir="auto">{labels.unit}</span><input dir="ltr" value={a.unit} onChange={box('unit')} autoComplete="off" /></label>
      <label className="field"><span dir="auto">{labels.city}</span><input dir="ltr" value={a.city} onChange={box('city')} autoComplete="off" /></label>
      <label className="field"><span dir="auto">{labels.state}</span><input dir="ltr" value={a.state} onChange={box('state')} maxLength={2} autoComplete="off" placeholder="NY" /></label>
      <label className="field"><span dir="auto">{labels.zip}{zipRequired && ' *'}</span>
        <input dir="ltr" required={zipRequired} value={a.zip} onChange={box('zip')} inputMode="numeric" maxLength={10} autoComplete="off" /></label>
    </div>
  );
}
