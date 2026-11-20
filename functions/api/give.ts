// The payment page's own address for gifts (Moshe Henig, 2026-11-11). The page used to post straight to the
// rate-limiting gate on its workers.dev address; on some connections (a content filter) the replies never reached
// the browser, so a gift that went through showed an error. Now the page posts here, on its own site, and this
// passes the request on to the gate server-to-server, with the donor's address so the gate's per-donor limit holds.

const GATE = 'https://oizer-give-gate.smueller-cd9.workers.dev/';
interface Env { GIVE_GATE_SECRET?: string }
interface Ctx { request: Request; env: Env }

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' } });

export async function onRequestPost({ request, env }: Ctx) {
  const url = new URL(request.url);
  const body = await request.text();
  if (body.length > 32_000) return json({ error: 'Something went wrong. Please try again.' }, 413);
  let res: Response;
  try {
    res = await fetch(GATE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: request.headers.get('Origin') ?? url.origin,
        'x-oizer-gate-proxy': env.GIVE_GATE_SECRET ?? '',
        'x-oizer-client-ip': request.headers.get('cf-connecting-ip') ?? '',
      },
      body,
    });
  } catch {
    return json({ error: 'We couldn\'t reach the payment processor. Please try again.', unreachable: true }, 502);
  }
  const text = await res.text();
  return new Response(text, { status: res.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' } });
}

export const onRequestGet = () => json({ error: 'Method not allowed' }, 405);
