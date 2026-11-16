import { Pencil, X } from 'lucide-react';
import { Overlay } from '../pages/Pledges';
import { donationColumns } from '../pages/donationColumns';
import { ReceiptActions } from '../pages/Receipts';
import type { Row } from '../lib/supabase';

/**
 * A donation, read-only (Moshe Henig, 2026-11-15, readiness #41): clicking a donation shows it first, with Edit and
 * Issue Receipt at the top, so a look doesn't risk a change. The same fields and formatting as the Transactions list.
 */
export default function DonationView({ row, onEdit, onClose }: { row: Row; onEdit: () => void; onClose: () => void }) {
  const fields = donationColumns().filter(c => c.key !== 'chargeback_fee' || row.chargeback_fee != null);
  const shown = (c: (typeof fields)[number]) => {
    const v = c.render ? c.render(row) : c.value ? c.value(row) : row[c.key];
    return v === null || v === undefined || v === '' ? <span className="muted">—</span> : v;
  };
  return (
    <Overlay onClose={onClose} size="medium">
      <div className="form-head">
        <h2>Donation {row.id}</h2>
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><X size={20} /></button>
      </div>
      <div className="donation-view-actions">
        <button type="button" className="btn primary" onClick={onEdit}><Pencil size={15} /> Edit</button>
        <ReceiptActions donationId={String(row.id)} />
      </div>
      <dl className="donation-view">
        {fields.map(c => (
          <div key={c.key} className={c.long ? 'wide' : undefined}>
            <dt>{c.label}</dt>
            <dd>{shown(c)}</dd>
          </div>
        ))}
      </dl>
    </Overlay>
  );
}
