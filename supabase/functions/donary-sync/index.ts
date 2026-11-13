// Sends donors, collectors, campaigns and reasons (sub-campaigns) to Donary Enterprise through its Save APIs
// (PUT /v1/External/Save{Donor,Collector,Campaign,Reason}, header APIKey). The database queues each change and
// builds what is sent; this only delivers it and reports Donary's answer. Called every 5 minutes by the database
// with the cron token. JWT verification is off.

const url = Deno.env.get('SUPABASE_URL')!;
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const DONARY = (Deno.env.get('DONARY_API_BASE') ?? 'https://webapi.donary.com').replace(/\/$/, '');
const PATH: Record<string, string> = { donor: 'SaveDonor', collector: 'SaveCollector', campaign: 'SaveCampaign', reason: 'SaveReason' };

async function rpc(name: string, args: unknown) {
  const res = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`${name}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

Deno.serve(async req => {
  const token = req.headers.get('x-cron-token') ?? '';
  if (!token || await rpc('check_cron_token', { p_token: token }) !== true) return new Response('Forbidden', { status: 403 });
  const items = await rpc('donary_claim', { p_limit: 50 }) as { id: number; kind: string; payload: unknown; api_key: string }[];
  let sent = 0, failed = 0;
  for (const it of items) {
    let ok = false, error: string | null = null;
    try {
      const res = await fetch(`${DONARY}/v1/External/${PATH[it.kind]}`, {
        method: 'PUT',
        headers: { APIKey: it.api_key, 'Content-Type': 'application/json' },
        body: JSON.stringify(it.payload),
        signal: AbortSignal.timeout(20_000),
      });
      ok = res.ok;
      if (!ok) error = `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`;
    } catch (e) {
      error = (e as Error).message;
    }
    await rpc('donary_sent', { p_id: it.id, p_ok: ok, p_error: error });
    ok ? sent++ : failed++;
  }
  return Response.json({ sent, failed });
});
