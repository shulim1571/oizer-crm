import { useEffect, useState } from 'react';
import RecordForm from './RecordForm';
import SearchSelect from './SearchSelect';
import { useAuth } from '../lib/auth';
import { clearLookups, donorOptions, type Option } from '../lib/lookups';
import { donorFields } from '../lib/schemas';
import { supabase, type Row } from '../lib/supabase';

// Adding a donor without leaving the page. Admins get the full donor form; fundraisers the short one the Donors
// page gives them, saved through add_fundraiser_donor like there.

export function NewDonorDialog({ onClose, onSaved, name }: { onClose: () => void; onSaved: (donor: Row) => void; name?: string }) {
  const { isAdmin } = useAuth();
  const [firstGuess, ...rest] = (name ?? '').trim().split(/\s+/);
  const lastGuess = rest.join(' ');
  if (isAdmin) {
    return (
      <RecordForm table="donors" title="New donor" saveLabel="Add donor" fields={donorFields}
        defaults={{ country: 'US', ...(name ? { first_name: firstGuess, last_name: lastGuess } : {}) }}
        onClose={onClose}
        onSaved={row => { clearLookups(); onSaved(row); }} />
    );
  }
  return <FundraiserDonorForm first={firstGuess ?? ''} last={lastGuess} onClose={onClose} onSaved={onSaved} />;
}

function FundraiserDonorForm({ first: f0, last: l0, onClose, onSaved }: { first: string; last: string; onClose: () => void; onSaved: (donor: Row) => void }) {
  const [v, setV] = useState({ first: f0, last: l0, phone: '', email: '', address: '', country: 'US' });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV(x => ({ ...x, [k]: e.target.value }));
  async function save() {
    setError(null);
    const { data, error: e } = await supabase.rpc('add_fundraiser_donor', {
      p_fields: { first_name: v.first, last_name: v.last, phone: v.phone || null, email: v.email || null, address: v.address || null, country: v.country },
    });
    if (e) return setError(e.message);
    clearLookups();
    onSaved({ id: data, first_name: v.first, last_name: v.last });
  }
  return (
    <div className="modal-back" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="modal"><div className="record-form">
        <div className="form-head"><h2>New donor</h2></div>
        <p className="muted small">Look them up first, so nobody ends up with two records.</p>
        <div className="fields">
          <label className="field"><span>First name *</span><input value={v.first} onChange={set('first')} /></label>
          <label className="field"><span>Last name *</span><input value={v.last} onChange={set('last')} /></label>
          <label className="field"><span>Phone</span><input value={v.phone} onChange={set('phone')} /></label>
          <label className="field"><span>Email</span><input type="email" value={v.email} onChange={set('email')} /></label>
          <label className="field"><span>Address</span><input value={v.address} onChange={set('address')} /></label>
          <label className="field"><span>Country</span>
            <select value={v.country} onChange={set('country')}>
              {[['US', 'USA'], ['CA', 'Canada'], ['IL', 'Israel'], ['GB', 'England']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select></label>
        </div>
        {error && <div className="error">{error}</div>}
        <div className="form-actions"><div className="spacer" />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={!v.first.trim() || !v.last.trim()} onClick={save}>Add donor</button></div>
      </div></div>
    </div>
  );
}

/** A donor search with "+ Create new donor" at the top; a donor added there is chosen right away. */
export default function DonorPicker({ value, onChange, placeholder, required }: {
  value: string | null; onChange: (id: string | null) => void; placeholder?: string; required?: boolean;
}) {
  const [options, setOptions] = useState<Option[]>([]);
  const [adding, setAdding] = useState(false);
  useEffect(() => { void donorOptions().then(setOptions); }, []);
  return (
    <>
      <SearchSelect value={value} options={options} onChange={onChange} placeholder={placeholder ?? 'Search donors…'} required={required}
        onCreate={() => setAdding(true)} createLabel="donor" />
      {adding && (
        <NewDonorDialog onClose={() => setAdding(false)} onSaved={async row => {
          setAdding(false);
          setOptions(await donorOptions());
          onChange(String(row.id));
        }} />
      )}
    </>
  );
}
