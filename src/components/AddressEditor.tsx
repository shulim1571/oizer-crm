import { useState } from 'react';
import { X } from 'lucide-react';
import { joinAddress, splitAddress, type AddressFields } from '../lib/addressParts';
import { supabase, type Row } from '../lib/supabase';
import { Overlay } from '../pages/Pledges';
import AddressCheck from './AddressCheck';

/**
 * Edit a donor's address right from the donor's Address section (Moshe Henig, 2026-11-12: "i want to fill in addresses
 * even in the app under donor address"). Street, apartment, city, state and ZIP boxes; saved to the donor's address.
 */
export default function AddressEditor({ donor, onClose, onSaved }: { donor: Row; onClose: () => void; onSaved: () => void }) {
  const [a, setA] = useState<AddressFields>(() => splitAddress(donor.address));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof AddressFields) => (e: { target: { value: string } }) => setA(x => ({ ...x, [k]: e.target.value }));
  const combined = joinAddress(a);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (a.state.trim() && !/^[A-Za-z]{2}$/.test(a.state.trim())) return setError('Use the two-letter state, for example NY.');
    if (a.zip.trim() && !/^\d{5}(-\d{4})?$/.test(a.zip.trim())) return setError('A ZIP is 5 digits, or 5+4 like 11219-1234.');
    setSaving(true);
    const { error: err } = await supabase.from('donors').update({ address: combined || null }).eq('id', donor.id);
    setSaving(false);
    if (err) return setError(err.message);
    onSaved();
  }
  return (
    <Overlay onClose={onClose}>
      <form className="record-form" onSubmit={save}>
        <div className="form-head"><h2>Address · {donor.display_name}</h2>
          <button type="button" className="icon-btn" title="Close" onClick={onClose}><X size={18} /></button></div>
        <div className="fields two">
          <label className="field wide"><span>Street</span><input value={a.street} onChange={set('street')} autoComplete="off" placeholder="123 Main St" /></label>
          <label className="field"><span>Apt / Suite</span><input value={a.unit} onChange={set('unit')} autoComplete="off" /></label>
          <label className="field"><span>City</span><input value={a.city} onChange={set('city')} autoComplete="off" /></label>
          <label className="field"><span>State</span><input value={a.state} onChange={set('state')} maxLength={2} autoComplete="off" placeholder="NY" /></label>
          <label className="field"><span>ZIP</span><input value={a.zip} onChange={set('zip')} inputMode="numeric" maxLength={10} autoComplete="off" /></label>
        </div>
        <AddressCheck value={combined} oneLine={false} onUse={v => setA(splitAddress(v))} />
        {combined && <p className="muted small">Saved as: <span style={{ whiteSpace: 'pre-line' }}>{combined}</span></p>}
        {error && <div className="error">{error}</div>}
        <div className="form-actions"><div className="spacer" />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={saving}>{saving ? 'Saving…' : 'Save address'}</button></div>
      </form>
    </Overlay>
  );
}
