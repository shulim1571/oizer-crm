import { useState } from 'react';
import { X } from 'lucide-react';
import { addressProblem, joinAddress, splitAddress, type AddressFields } from '../lib/addressParts';
import { supabase, type Row } from '../lib/supabase';
import { Overlay } from '../pages/Pledges';
import AddressBoxes from './AddressBoxes';

/**
 * Edit a donor's address right from the donor's Address section (Moshe Henig, 2026-11-12: "i want to fill in addresses
 * even in the app under donor address"). Street, apartment, city, state and ZIP boxes; saved to the donor's address.
 * Suggestions while typing the street fill the rest when one is picked (Shulim, 2026-11-25; the USPS check was removed).
 */
export default function AddressEditor({ donor, onClose, onSaved }: { donor: Row; onClose: () => void; onSaved: () => void }) {
  const [a, setA] = useState<AddressFields>(() => splitAddress(donor.address));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const combined = joinAddress(a);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const problem = addressProblem(a);
    if (problem) return setError(problem);
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
          <button type="button" className="icon-btn" title="Close" onClick={onClose}><X size={20} /></button></div>
        <AddressBoxes value={donor.address} onChange={(_, parts) => setA(parts)} />
        {combined && <p className="muted small">Saved as: <span style={{ whiteSpace: 'pre-line' }}>{combined}</span></p>}
        {error && <div className="error">{error}</div>}
        <div className="form-actions"><div className="spacer" />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={saving}>{saving ? 'Saving…' : 'Save address'}</button></div>
      </form>
    </Overlay>
  );
}
