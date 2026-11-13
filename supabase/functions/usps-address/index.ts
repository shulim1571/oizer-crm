// USPS address standardization (Shulim, 2026-11-12). Called from the portal by a signed-in admin or fundraiser with
// { org, address: "free text" }. The database checks the person, as them, and names the organization; this function
// alone reads that organization's own USPS credentials (stored encrypted, set by its Super Admin), asks USPS's
// Addresses API, and returns the standardized address. Nothing is saved: the person decides whether to use it.
import { addressQuery, deliverability, formatUsAddress, parseUsAddress, USPS_HOSTS, type UspsEnvironment } from '../_shared/usps.ts';

const url = Deno.env.get('SUPABASE_URL')!;
const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-org-id',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

async function rpc(name: string, args: unknown, auth: { token: string; org: string } | null) {
  const res = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: auth ? anonKey : serviceKey, Authorization: `Bearer ${auth ? auth.token : serviceKey}`, 'Content-Type': 'application/json',
      ...(auth ? { 'x-org-id': auth.org } : {}),
    },
    body: JSON.stringify(args),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.message ?? `Database error ${res.status}`);
  return data;
}

// One token per organization, reused until shortly before it runs out.
const tokens = new Map<string, { token: string; until: number }>();
async function uspsToken(org: string, host: string, key: string, secret: string): Promise<string> {
  const cached = tokens.get(org);
  if (cached && cached.until > Date.now()) return cached.token;
  const res = await fetch(`${host}/oauth2/v3/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ client_id: key, client_secret: secret, grant_type: 'client_credentials' }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.access_token) {
    throw new Error(res.status === 401 || res.status === 400 ? 'USPS didn\'t accept this organization\'s consumer key and secret' : `USPS sign-in failed (${res.status})`);
  }
  const seconds = Number(data.expires_in) || 3600;
  tokens.set(org, { token: data.access_token, until: Date.now() + Math.max(60, seconds - 120) * 1000 });
  return data.access_token;
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply({ error: 'Method not allowed' }, 405);
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return reply({ error: 'Sign in to check addresses' }, 401);
  let b: { org?: string; address?: string };
  try { b = await req.json(); } catch { return reply({ error: 'Bad request' }, 400); }
  if (!b.org || typeof b.address !== 'string') return reply({ error: 'Missing organization or address' }, 400);

  const parts = parseUsAddress(b.address);
  if (!parts) return reply({ error: 'Write the address as a street line, then city, state and ZIP (for example "123 Main St, Brooklyn NY 11219").' });

  let org: string;
  try { org = await rpc('usps_check_allowed', {}, { token, org: b.org }); } catch (e) { return reply({ error: e instanceof Error ? e.message : String(e) }, 403); }
  let keys: { consumer_key: string; consumer_secret: string; environment: UspsEnvironment } | undefined;
  try { [keys] = await rpc('org_usps_keys', { p_org: org }, null); } catch (e) { return reply({ error: e instanceof Error ? e.message : String(e) }); }
  if (!keys?.consumer_key || !keys.consumer_secret) return reply({ error: 'USPS address checks aren\'t set up for this organization yet' });
  const host = USPS_HOSTS[keys.environment] ?? USPS_HOSTS.production;

  try {
    let access = await uspsToken(org, host, keys.consumer_key, keys.consumer_secret);
    const ask = () => fetch(`${host}/addresses/v3/address?${addressQuery(parts)}`, { headers: { accept: 'application/json', Authorization: `Bearer ${access}` }, signal: AbortSignal.timeout(15000) });
    let res = await ask();
    if (res.status === 401) { tokens.delete(org); access = await uspsToken(org, host, keys.consumer_key, keys.consumer_secret); res = await ask(); }
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.address) {
      // USPS doesn't publish its error format; pass on whatever message it gives.
      const said = data?.error?.message ?? data?.message ?? data?.error_description ?? (typeof data?.error === 'string' ? data.error : null);
      return reply({ error: res.status === 429 ? 'USPS is limiting requests right now; try again in a minute.' : `USPS couldn't match this address${said ? `: ${said}` : ` (${res.status})`}.`, sent: parts });
    }
    const dpv = data.additionalInfo?.DPVConfirmation as string | undefined;
    return reply({
      sent: parts,
      address: data.address,
      formatted: formatUsAddress(data.address),
      formatted_one_line: formatUsAddress(data.address, true),
      dpv: dpv ?? null,
      deliverable: deliverability(dpv),
      corrections: Array.isArray(data.corrections) ? data.corrections.map((c: { text?: string }) => c.text).filter(Boolean) : [],
      matches: Array.isArray(data.matches) ? data.matches.map((m: { text?: string }) => m.text).filter(Boolean) : [],
    });
  } catch (e) {
    return reply({ error: e instanceof Error ? e.message : String(e), sent: parts });
  }
});
