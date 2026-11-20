import { Star } from 'lucide-react';
import type { Row } from '../lib/supabase';

/**
 * A campaign's name as the Campaigns list shows it: the internal name (the office's own), with the public name under
 * it when that differs, and a star when featured. Shared so the Task Sheet looks the same (Moshe Henig, 2026-11-12).
 */
export default function CampaignName({ c }: { c: { featured?: unknown; internal_name?: unknown; campaign_name?: unknown; external_name?: unknown } | Row }) {
  return (
    <div>
      <div>{!!c.featured && <Star size={14} className="featured" />} {String(c.internal_name || c.campaign_name || '')}</div>
      {!!c.external_name && c.external_name !== c.internal_name && <div className="muted small">{String(c.external_name)}</div>}
    </div>
  );
}
