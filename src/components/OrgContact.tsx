import { Mail, Phone } from 'lucide-react';

/**
 * The organization's email and phone from its settings (Moshe Henig, 2026-11-10), on the campaign banner.
 * Each is left out when it isn't set.
 */
export default function OrgContact({ email, phone }: { email?: string | null; phone?: string | null }) {
  const e = email?.trim();
  const p = phone?.trim();
  if (!e && !p) return null;
  return (
    <div className="sub org-contact">
      {e && <a href={`mailto:${e}`}><Mail size={13} /> {e}</a>}
      {p && <a href={`tel:${p.replace(/[^\d+]/g, '')}`}><Phone size={13} /> {p}</a>}
    </div>
  );
}
