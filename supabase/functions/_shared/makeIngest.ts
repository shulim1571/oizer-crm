// Make ingest (Shulim, 2026-11-12): one address per organization and source,
//   POST .../functions/v1/make-ingest?org=<organization id>&source=<source>
// with the organization's own secret in the x-donorbase-key header. The secret is checked in the database against
// a stored fingerprint; the body goes to make_ingest() and is never logged here (it can carry card tokens).

export const MAKE_SOURCES = ['donary-payment', 'donary-pledge', 'donary-void', 'donary-schedule', 'sola', 'elevon'] as const;
export const KEY_HEADER = 'x-donorbase-key';
const MAX_BODY = 512 * 1024;

type Rpc = (name: string, args: unknown) => Promise<unknown>;

// PostgREST answers a void function with 204 and an empty body, so read text, not json().
export function makeRpc(url: string, serviceKey: string, f: typeof fetch = fetch): Rpc {
  return async (name, args) => {
    const res = await f(`${url}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    const text = await res.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!res.ok) throw new Error(body?.message ?? `${name}: ${res.status}`);
    return body;
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export async function parseBody(req: Request): Promise<Record<string, unknown> | null> {
  const text = await req.text();
  if (text.length > MAX_BODY) return null;
  const type = req.headers.get('content-type') ?? '';
  if (type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text).entries());
  try {
    const v = JSON.parse(text || '{}');
    // Make can send a one-item array (a bundle); take the item.
    const o = Array.isArray(v) ? v[0] : v;
    return o && typeof o === 'object' ? o : null;
  } catch {
    return null;
  }
}

export async function handleMakeIngest(req: Request, rpc: Rpc): Promise<Response> {
  if (req.method !== 'POST') return json(405, { ok: false, error: 'Use POST' });
  const q = new URL(req.url).searchParams;
  const org = q.get('org') ?? '';
  const source = q.get('source') ?? '';
  if (!/^[0-9a-f-]{36}$/i.test(org)) return json(400, { ok: false, error: 'Unknown organization' });
  if (!(MAKE_SOURCES as readonly string[]).includes(source)) return json(400, { ok: false, error: 'Unknown source', sources: MAKE_SOURCES });
  const key = req.headers.get(KEY_HEADER)?.trim();
  if (!key) return json(401, { ok: false, error: `Missing ${KEY_HEADER} header` });
  const body = await parseBody(req);
  if (!body) return json(400, { ok: false, error: 'Body must be JSON (or form fields), up to 512 KB' });
  let r: any;
  try {
    r = await rpc('make_ingest', { p_org: org, p_key: key, p_source: source, p_body: body });
  } catch {
    return json(503, { ok: false, error: 'Unavailable, try again' });
  }
  const status = Number(r?.status) || (r?.ok ? 200 : 500);
  const { status: _s, ...rest } = r ?? {};
  return json(status, rest);
}
