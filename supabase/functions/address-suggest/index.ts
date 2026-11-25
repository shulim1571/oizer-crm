// Address suggestions while typing (Shulim, 2026-11-25). Called from the portal by a signed-in admin or fundraiser
// with { org, query }. The database checks the person, as them, and books the lookup against the limits that keep
// usage inside Azure Maps' free tier (address_suggest_begin); then this function asks Azure Maps Search Address
// (api-version 1.0, typeahead, US only) with the platform key AZURE_MAPS_KEY and returns up to five street addresses,
// narrowed to the organization's region or with it first, when it has one (address_region).
// Nothing is saved: the person picks one (or none). The key never leaves this function and is never logged.
import { AZURE_SEARCH_ADDRESS, cleanQuery, readRegion, searchParams, toSuggestions, type Region } from '../_shared/azureMaps.ts';
import { apiHeaders } from '../_shared/keys.ts';

const url = Deno.env.get('SUPABASE_URL')!;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-org-id',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
// The database's own refusals that are meant for the person; anything else is logged and replaced with a fixed message.
const SAY_AS_IS = [
  'Sign in to look up addresses',
  'Address suggestions are paused for a moment; keep typing or try again in a minute',
  'Address suggestions have reached today\'s limit; type the address in full',
  'Address suggestions have reached this month\'s limit; type the address in full',
];
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// Null when the lookup is booked; otherwise the fixed message to show the person (never an exception's text).
async function begin(token: string, org: string): Promise<string | null> {
  try {
    const res = await fetch(`${url}/rest/v1/rpc/address_suggest_begin`, {
      method: 'POST', headers: { ...apiHeaders(token), 'Content-Type': 'application/json', 'x-org-id': org }, body: '{}',
    });
    if (res.ok) return null;
    const data = await res.json().catch(() => null);
    const said = SAY_AS_IS.find(m => m === String(data?.message ?? ''));
    if (!said) console.error('address-suggest permission check failed: %s', res.status);
    return said ?? 'You can\'t look up addresses for this organization.';
  } catch (e) {
    console.error('address-suggest permission check failed: %s', e instanceof Error ? e.name : 'error');
    return 'Couldn\'t check your access. Please try again.';
  }
}

// The organization's region setting (address_region: states, show only or show first); null when not set or unreadable,
// and then suggestions simply aren't narrowed. Read with the server key, for the organization the database just confirmed.
async function orgRegion(org: string): Promise<Region | null> {
  if (!/^[0-9a-f-]{36}$/i.test(org)) return null;
  try {
    const res = await fetch(`${url}/rest/v1/settings?org_id=eq.${org}&key=eq.address_region&select=value`, { headers: apiHeaders() });
    if (!res.ok) return null;
    const rows = await res.json().catch(() => null) as { value?: unknown }[] | null;
    return readRegion(rows?.[0]?.value);
  } catch {
    return null;
  }
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply({ error: 'Method not allowed' }, 405);
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return reply({ error: 'Sign in to look up addresses' }, 401);
  let b: { org?: unknown; query?: unknown };
  try { b = await req.json(); } catch { return reply({ error: 'Bad request' }, 400); }
  if (typeof b.org !== 'string' || !b.org) return reply({ error: 'Missing organization' }, 400);
  const query = cleanQuery(b.query);
  if (!query) return reply({ suggestions: [] });   // under 3 characters (or far too long): nothing to look up, nothing booked

  const refused = await begin(token, b.org);
  if (refused) return reply({ error: refused, suggestions: [] }, refused.startsWith('Address suggestions') ? 429 : 403);

  const region = await orgRegion(b.org);
  const key = Deno.env.get('AZURE_MAPS_KEY');
  if (!key) { console.error('address-suggest: AZURE_MAPS_KEY is not set'); return reply({ error: 'Address suggestions aren\'t available right now.', suggestions: [] }); }
  try {
    const params = searchParams(query, region);
    params.set('subscription-key', key);
    const res = await fetch(`${AZURE_SEARCH_ADDRESS}?${params}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      // Only the status is logged: the request address carries the key.
      console.error('address-suggest: Azure Maps answered %s', res.status);
      return reply({ error: res.status === 429 ? 'Address suggestions are busy; try again in a moment.' : 'Address suggestions aren\'t available right now.', suggestions: [] });
    }
    return reply({ suggestions: toSuggestions(await res.json().catch(() => null), region) });
  } catch (e) {
    console.error('address-suggest: Azure Maps request failed: %s', e instanceof Error ? e.name : 'error');
    return reply({ error: 'Couldn\'t reach address suggestions. Please try again.', suggestions: [] });
  }
});
