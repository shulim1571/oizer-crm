// Donary Enterprise webhooks: charges, voids, pledges and schedules from Donary devices.
//   POST /functions/v1/donary-webhook?event=charge|void|pledge|schedule&token=<the organization's webhook token>
// Donary doesn't sign its webhooks and needs addresses that work without a login, so the long random token in the
// address is what identifies the organization (Settings → Sources & Machines → Donary; it can be changed there).
// The database keeps each event once and does the work. Anything recorded, already seen or kept for an admin
// answers 200, so Donary doesn't retry and email about it; only our own failure answers 500, so Donary retries.
// JWT verification is off.

const url = Deno.env.get('SUPABASE_URL')!;
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const EVENTS = ['charge', 'void', 'pledge', 'schedule'];

Deno.serve(async req => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const u = new URL(req.url);
  const event = u.searchParams.get('event') ?? '';
  const token = u.searchParams.get('token') ?? '';
  if (!EVENTS.includes(event)) return new Response('Unknown event', { status: 404 });
  if (!/^[0-9a-f]{48}$/.test(token)) return new Response('Unknown address', { status: 401 });
  let payload: unknown;
  try {
    payload = JSON.parse(await req.text());
  } catch {
    return new Response('Expected JSON', { status: 400 });
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return new Response('Expected a JSON object', { status: 400 });
  const res = await fetch(`${url}/rest/v1/rpc/donary_ingest`, {
    method: 'POST',
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_token: token, p_event: event, p_payload: payload }),
  }).catch(() => null);
  if (!res?.ok) return new Response('Try again', { status: 500 });
  const result = await res.json();
  if (result === null) return new Response('Unknown address', { status: 401 });
  return Response.json({ received: true, status: result.status });
});
