// Web addresses for organizations, through Cloudflare. A Super Admin asks for an address on the setup screen;
// the database checks and records the request as them first, then this function asks Cloudflare for the address
// and its certificate and records what the organization must put in its DNS. Cloudflare verifies the domain and
// issues the certificate on its own once the records are in place; "Check now", and a job every 10 minutes,
// ask again. An address leads to the organization only when both are active.
//
// Two ways to ask Cloudflare, chosen by the DOMAIN_PROVIDER secret:
//   pages  Custom domains on the Pages project (free, up to 100 on the Free plan). Works with trubase.org's DNS
//          where it is today. The organization adds a CNAME to <project>.pages.dev.
//   saas   Cloudflare for SaaS custom hostnames on a zone hosted at Cloudflare (CF_SAAS_ZONE_ID), routed to the
//          app by the router Worker. 100 hostnames included, then $0.10 per hostname per month.
// Nothing happens until CF_DOMAINS_TOKEN is set. JWT verification is off so the scheduled job can call it;
// people are checked by the database with their own token.

const url = Deno.env.get('SUPABASE_URL')!;
const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const cfToken = Deno.env.get('CF_DOMAINS_TOKEN') ?? '';
const account = Deno.env.get('CF_ACCOUNT_ID') ?? '';
const project = Deno.env.get('CF_PAGES_PROJECT') ?? 'oizer-drm';
const zone = Deno.env.get('CF_SAAS_ZONE_ID') ?? '';
const saasTarget = Deno.env.get('CF_SAAS_TARGET') ?? '';
const provider: 'pages' | 'saas' = (Deno.env.get('DOMAIN_PROVIDER') ?? (zone ? 'saas' : 'pages')) === 'saas' ? 'saas' : 'pages';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-org-id',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: CORS });

async function rpc(name: string, args: unknown, auth: { token: string; org?: string } | null) {
  const res = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: auth ? anonKey : serviceKey,
      Authorization: `Bearer ${auth ? auth.token : serviceKey}`,
      'Content-Type': 'application/json',
      ...(auth?.org ? { 'x-org-id': auth.org } : {}),
    },
    body: JSON.stringify(args),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.message ?? `${name} failed (${res.status})`);
  return body;
}

async function cf(method: string, path: string, body?: unknown) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: { Authorization: `Bearer ${cfToken}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { ok: res.ok && json?.success !== false, status: res.status, result: json?.result, error: json?.errors?.[0]?.message as string | undefined };
}

interface Record { type: string; name: string; value: string; purpose: string }
interface Answer { provider_id: string | null; status: string; ssl_status: string | null; records: Record[]; error: string | null }

// --- Pages custom domains -----------------------------------------------------
function readPages(host: string, r: any, error?: string): Answer {
  const records: Record[] = [{ type: 'CNAME', name: host, value: `${project}.pages.dev`, purpose: 'Sends the address to the app' }];
  const v = r?.validation_data;
  if (v?.method === 'txt' && v.txt_name) records.push({ type: 'TXT', name: v.txt_name, value: v.txt_value, purpose: 'Proves the domain for the certificate' });
  const s = r?.status as string | undefined;
  return {
    provider_id: host,
    status: s === 'active' ? 'active' : ['error', 'blocked', 'deactivated'].includes(s ?? '') ? 'failed' : 'pending',
    ssl_status: v?.status === 'active' || (s === 'active' && !v) ? 'active' : v?.status ?? 'pending',
    records,
    error: error ?? v?.error_message ?? r?.verification_data?.error_message ?? null,
  };
}
const pages = {
  async create(host: string) {
    const r = await cf('POST', `/accounts/${account}/pages/projects/${project}/domains`, { name: host });
    return r.ok ? readPages(host, r.result) : failed(r.error);
  },
  async check(host: string) {
    const r = await cf('GET', `/accounts/${account}/pages/projects/${project}/domains/${host}`);
    if (!r.ok) return failed(r.error);
    // Ask Cloudflare to look at the DNS again while it waits.
    if (r.result?.status !== 'active') await cf('PATCH', `/accounts/${account}/pages/projects/${project}/domains/${host}`);
    return readPages(host, r.result);
  },
  async remove(host: string) {
    const r = await cf('DELETE', `/accounts/${account}/pages/projects/${project}/domains/${host}`);
    return r.ok || r.status === 404;
  },
};

// --- Cloudflare for SaaS custom hostnames ---------------------------------------
function readSaas(host: string, r: any, error?: string): Answer {
  const records: Record[] = [{ type: 'CNAME', name: host, value: saasTarget, purpose: 'Sends the address to the app' }];
  const own = r?.ownership_verification;
  if (own?.name && r?.status !== 'active') records.push({ type: 'TXT', name: own.name, value: own.value, purpose: 'Proves you own the domain' });
  for (const v of r?.ssl?.validation_records ?? []) {
    if (v.txt_name) records.push({ type: 'TXT', name: v.txt_name, value: v.txt_value, purpose: 'Proves the domain for the certificate' });
  }
  const s = r?.status as string | undefined;
  return {
    provider_id: r?.id ?? null,
    status: s === 'active' ? 'active' : ['blocked', 'moved', 'deleted'].includes(s ?? '') ? 'failed' : 'pending',
    ssl_status: r?.ssl?.status ?? 'pending',
    records,
    error: error ?? r?.verification_errors?.[0] ?? r?.ssl?.validation_errors?.[0]?.message ?? null,
  };
}
const saas = {
  async create(host: string) {
    const r = await cf('POST', `/zones/${zone}/custom_hostnames`, { hostname: host, ssl: { method: 'txt', type: 'dv', settings: { min_tls_version: '1.2' } } });
    return r.ok ? readSaas(host, r.result) : failed(r.error);
  },
  async check(host: string, id: string) {
    const r = await cf('GET', `/zones/${zone}/custom_hostnames/${id}`);
    return r.ok ? readSaas(host, r.result) : failed(r.error);
  },
  async remove(_host: string, id: string) {
    const r = await cf('DELETE', `/zones/${zone}/custom_hostnames/${id}`);
    return r.ok || r.status === 404;
  },
};

const failed = (error?: string): Answer => ({ provider_id: null, status: 'failed', ssl_status: null, records: [], error: error ?? 'Cloudflare refused the request' });
const ready = () => !!cfToken && !!account && (provider === 'pages' || (!!zone && !!saasTarget));

async function record(id: string, a: Answer, prov: string | null = provider) {
  await rpc('record_web_address', {
    p_id: id, p_provider: prov, p_provider_id: a.provider_id, p_status: a.status, p_ssl_status: a.ssl_status,
    p_dns_records: a.records.length ? a.records : null, p_error: a.error,
  }, null);
}

async function check(row: { id: string; hostname: string; provider: string | null; provider_id: string | null }) {
  const p = row.provider === 'saas' ? 'saas' : row.provider === 'pages' ? 'pages' : provider;
  const a = !row.provider_id
    ? await (p === 'saas' ? saas : pages).create(row.hostname)
    : p === 'saas' ? await saas.check(row.hostname, row.provider_id) : await pages.check(row.hostname);
  await record(row.id, a, p);
  return a;
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));

    // The scheduled re-check.
    const cron = req.headers.get('x-cron-token');
    if (cron) {
      if (await rpc('check_cron_token', { p_token: cron }, null) !== true) return new Response('Forbidden', { status: 403 });
      if (!ready()) return reply({ checked: 0 });
      const rows = await rpc('web_addresses_to_check', {}, null) as any[];
      for (const r of rows) await check(r).catch(() => null);
      return reply({ checked: rows.length });
    }

    const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    const auth = { token, org: body.org ?? req.headers.get('x-org-id') ?? undefined };
    if (body.action === 'status') return reply({ ready: ready(), provider, target: provider === 'saas' ? saasTarget : `${project}.pages.dev` });
    if (!ready()) return reply({ error: 'Web address setup isn’t switched on for the platform yet. Ask the Platform Owner.' }, 400);

    if (body.action === 'add') {
      const [row] = await rpc('request_web_address', { p_kind: body.kind, p_hostname: body.hostname ?? null }, auth) as any[];
      const a = await check({ ...row, provider: null, provider_id: null });
      return reply({ id: row.id, hostname: row.hostname, ...a });
    }
    if (body.action === 'check') {
      // web_addresses() only lists the caller's own organization, for its admins.
      const rows = await rpc('web_addresses', {}, auth) as any[];
      const row = rows.find(r => r.id === body.id);
      if (!row) return reply({ error: 'That address isn’t part of this organization' }, 404);
      return reply(await check(row));
    }
    if (body.action === 'remove') {
      const [row] = await rpc('remove_web_address', { p_id: body.id }, auth) as any[];
      const removed = !row.provider_id ? true
        : row.provider === 'saas' ? await saas.remove(row.hostname, row.provider_id) : await pages.remove(row.hostname);
      if (!removed) return reply({ error: 'The address stopped leading here, but Cloudflare didn’t confirm removing it. Try again.' }, 502);
      await rpc('forget_web_address', { p_id: row.id }, null);
      return reply({ removed: true });
    }
    return reply({ error: 'Unknown action' }, 400);
  } catch (e) {
    return reply({ error: (e as Error).message }, 400);
  }
});
