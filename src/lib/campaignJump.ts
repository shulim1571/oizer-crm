import { supabase, type Row } from './supabase';

/** What the header's Campaign ID box looks for (Moshe Henig, 2026-11-12: "the campaign ID search doesn't work"). */
export const cleanJump = (text: string) => text.trim().replace(/[,()*%\\]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Campaigns matching what was typed in the Campaign ID box, best first: the exact ID (any case); the number without
 * its prefix (3040 finds AS-3040); then IDs containing it; then internal, public or plain names containing it.
 * Searches every campaign the person can see, not just a loaded page.
 */
export async function findCampaigns(text: string): Promise<Row[]> {
  const t = cleanJump(text);
  if (!t) return [];
  const pick = 'id, internal_name, campaign_name, external_name, status';
  const exact = await supabase.from('campaigns').select(pick).or(`id.ilike.${t},id.ilike.*-${t}`).limit(20);
  if ((exact.data ?? []).length) return rank(exact.data as Row[], t);
  const like = `*${t}*`;
  const loose = await supabase.from('campaigns').select(pick)
    .or(`id.ilike.${like},internal_name.ilike.${like},external_name.ilike.${like},campaign_name.ilike.${like}`).order('id').limit(20);
  return rank((loose.data ?? []) as Row[], t);
}

/** Exact ID first, then the prefix-less match, then the rest by ID. */
export function rank(rows: Row[], t: string): Row[] {
  const low = t.toLowerCase();
  const score = (r: Row) => { const id = String(r.id).toLowerCase(); return id === low ? 0 : id.endsWith(`-${low}`) ? 1 : 2; };
  return [...rows].sort((a, b) => score(a) - score(b) || String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
}
