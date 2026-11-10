// The rate-limiting gate in front of the public give function. Payment pages post here; each request is counted
// per donor IP and per campaign with Cloudflare's Workers rate-limit binding (free, no add-on), then forwarded to
// the Supabase give function with a shared secret only this gate knows. The give function refuses anything that
// didn't come through here, so the limits can't be skipped by calling it directly.
//
// Limits are approximate and kept per Cloudflare location (that's how the binding works); the database's own
// limit on declined attempts per connection stays behind this as a second line.

export interface Limiter { limit(o: { key: string }): Promise<{ success: boolean }> }
export interface GateEnv {
  PER_IP: Limiter;          // each donor connection
  PER_CAMPAIGN: Limiter;    // each organization's campaign, against card testing spread over many IPs
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  GIVE_GATE_SECRET: string;
  ALLOWED_ORIGINS: string;  // comma-separated; a leading "*." allows subdomains
}

const json = (body: unknown, status: number, headers: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

/**
 * The key a connection is counted under: an IPv4 address as it is, an IPv6 address by its /64 network, since one
 * household or server can use any of the 2^64 addresses in its block and would otherwise never be counted twice.
 */
export function ipKey(ip: string | null): string {
  if (!ip) return 'unknown';
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const full = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return full.slice(0, 4).map(h => h.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

export function allowedOrigin(origin: string | null, allowed: string): string | null {
  if (!origin) return null;
  let host: string;
  try { host = new URL(origin).hostname; } catch { return null; }
  for (const raw of allowed.split(',').map(s => s.trim()).filter(Boolean)) {
    if (raw.startsWith('*.') ? host.endsWith(raw.slice(1)) : host === raw) return origin;
  }
  return null;
}

export async function handle(req: Request, env: GateEnv, fetcher: typeof fetch = fetch): Promise<Response> {
  const origin = allowedOrigin(req.headers.get('Origin'), env.ALLOWED_ORIGINS);
  const cors: Record<string, string> = origin
    ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Max-Age': '600', Vary: 'Origin' }
    : { Vary: 'Origin' };
  if (req.method === 'OPTIONS') return new Response(null, { status: origin ? 204 : 403, headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405, cors);
  if (!origin) return json({ error: 'Please use the campaign\'s payment page.' }, 403, cors);

  const raw = await req.text();
  if (raw.length > 32_000) return json({ error: 'Something went wrong. Please try again.' }, 413, cors);
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw); } catch { return json({ error: 'Something went wrong. Please try again.' }, 400, cors); }

  const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
  const campaign = `${String(body.org ?? '')}:${String(body.campaign ?? '')}`;
  const [byIp, byCampaign] = await Promise.all([
    env.PER_IP.limit({ key: `ip:${ipKey(ip)}` }),
    env.PER_CAMPAIGN.limit({ key: `campaign:${campaign}` }),
  ]);
  if (!byIp.success || !byCampaign.success) {
    return json({ error: 'Too many tries in a short time. Please wait a minute and try again.', rate_limited: true }, 429, { ...cors, 'Retry-After': '60' });
  }

  const res = await fetcher(`${env.SUPABASE_URL.replace(/\/$/, '')}/functions/v1/give`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
      'x-give-gate': env.GIVE_GATE_SECRET, 'x-oizer-client-ip': ip,
    },
    body: raw,
  });
  return new Response(res.body, { status: res.status, headers: { 'Content-Type': res.headers.get('Content-Type') ?? 'application/json', ...cors } });
}
