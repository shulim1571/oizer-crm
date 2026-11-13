// The public, read-only API. Organizations call it from their own systems with a key their Super Admin made:
//
//   GET /functions/v1/api/v1/campaigns            ?limit=50&after=<next>&updated_since=2026-11-01T00:00:00Z
//   GET /functions/v1/api/v1/campaigns/<id>
//   GET /functions/v1/api/v1/donors[/<id>]
//   GET /functions/v1/api/v1/donations[/<id>]     also ?campaign_id=…&donor_id=…
//   Authorization: Bearer oz_live_…
//
// JWT verification is off: the key is the credential. The database checks the key, its scopes and the rate
// limit (60 a minute per key) and returns only that organization's records. No CORS: keys belong on servers,
// not in web pages.

const url = Deno.env.get('SUPABASE_URL')!;
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const STATUS: Record<string, number> = { PT401: 401, PT403: 403, PT404: 404, PT422: 422, PT429: 429 };
const PARAMS = ['limit', 'after', 'updated_since', 'campaign_id', 'donor_id'];

const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });

Deno.serve(async req => {
  if (req.method !== 'GET') return reply({ error: 'The API is read-only: use GET' }, 405, { Allow: 'GET' });
  const u = new URL(req.url);
  // The path arrives as /api/v1/<resource>[/<id>] (or without the leading /api when called through a custom route).
  const parts = u.pathname.split('/').filter(Boolean);
  const at = parts.indexOf('v1');
  const [resource, id, extra] = at >= 0 ? parts.slice(at + 1) : [];
  if (!resource) {
    return reply({ name: 'Oizer API', version: 'v1', resources: ['campaigns', 'donors', 'donations'], docs: 'Send Authorization: Bearer <key>' });
  }
  if (extra) return reply({ error: 'Not found' }, 404);

  const key = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  const params: Record<string, string> = {};
  for (const p of PARAMS) { const v = u.searchParams.get(p); if (v !== null && v !== '') params[p] = v; }
  if (id) params.id = decodeURIComponent(id);

  let res: Response;
  try {
    res = await fetch(`${url}/rest/v1/rpc/api_request`, {
      method: 'POST',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_key: key, p_resource: resource, p_params: params }),
    });
  } catch {
    return reply({ error: 'The service is unavailable. Try again shortly.' }, 503);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    // PostgREST answers a PTxxx error with that HTTP status and code; anything else is ours to hide.
    const status = STATUS[body?.code] ?? (Object.values(STATUS).includes(res.status) ? res.status : 500);
    const retry = status === 429 ? Number(/in (\d+) seconds/.exec(body?.message ?? '')?.[1] ?? 60) : null;
    return reply({ error: status === 500 ? 'Something went wrong' : body?.message }, status,
      retry ? { 'Retry-After': String(retry), 'X-RateLimit-Limit': '60', 'X-RateLimit-Remaining': '0' } : {});
  }
  const { rate, ...rest } = body;
  return reply(rest, 200, {
    'X-RateLimit-Limit': String(rate.limit), 'X-RateLimit-Remaining': String(rate.remaining), 'X-RateLimit-Reset': String(rate.reset),
  });
});
