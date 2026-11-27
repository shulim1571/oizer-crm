// Only for the Cloudflare for SaaS way of serving organizations' own addresses (DOMAIN_PROVIDER=saas).
// Custom hostnames arrive at the SaaS zone; this Worker fetches the same path from the Pages app and returns it.
// The browser keeps the organization's address, which is how the app knows the organization.

interface Env { ORIGIN: string }

export default {
  async fetch(req: Request, env: Env) {
    const incoming = new URL(req.url);
    const target = new URL(incoming.pathname + incoming.search, env.ORIGIN);
    const res = await fetch(new Request(target, req), { redirect: 'manual' });
    const headers = new Headers(res.headers);
    // Keep redirects on the organization's address.
    const loc = headers.get('Location');
    if (loc) headers.set('Location', loc.replace(env.ORIGIN.replace(/\/$/, ''), incoming.origin));
    return new Response(res.body, { status: res.status, headers });
  },
};
