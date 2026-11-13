import type { Row } from './supabase';

/**
 * Sort parts for a person's name: last name, then first name (Moshe Henig, 2026-11-12: donor and fundraiser lists sort
 * by last name first, both A-Z and Z-A). A record without a last name (an organization, say) sorts by its full name.
 */
export function lastFirst(r: Row, full: string): string[] {
  const last = String(r.last_name ?? '').trim();
  const first = String(r.first_name ?? '').trim();
  return last ? [last, first] : [String(r[full] ?? first).trim(), ''];
}
