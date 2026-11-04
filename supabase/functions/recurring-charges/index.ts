// Charges recurring donations that are due, each organization with its own Sola key and the donor's saved card
// token. The database calls this every hour, and when the office resumes or retries one, with a token only it
// knows. Deployed with JWT verification off. Each charge's answer is recorded in one step: the donation, and
// the schedule moved on or its retry set.

const url = Deno.env.get('SUPABASE_URL')!;
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const GATEWAY = 'https://x1.cardknox.com/gatewayjson';

async function rpc(name: string, args: unknown) {
  const res = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.message ?? `${name}: ${res.status}`);
  return body;
}

interface Due { org_id: string; id: string; invoice: string; amount: number; api_key: string; card_token: string | null; campaign_label: string | null; card_name: string | null; email: string | null }

async function charge(c: Due) {
  let result: Record<string, string>;
  if (!c.card_token) {
    result = { xResult: 'E', xError: 'The saved card is no longer on file' };
  } else {
    try {
      const res = await fetch(GATEWAY, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(45000),
        body: JSON.stringify({
          xKey: c.api_key, xVersion: '5.0.0', xSoftwareName: 'Oizer CRM', xSoftwareVersion: '1.0', xCommand: 'cc:sale',
          xAmount: Number(c.amount).toFixed(2), xToken: c.card_token, xInvoice: c.invoice, xName: c.card_name ?? undefined,
          xEmail: c.email ?? undefined, xDescription: c.campaign_label ? `Recurring: ${c.campaign_label}` : 'Recurring donation',
        }),
      });
      result = await res.json();
    } catch {
      // No answer: the charge stays pending for an hour, then Sola's webhook or the next run settles it.
      return 'pending';
    }
  }
  const keep = ['xResult', 'xStatus', 'xError', 'xErrorCode', 'xRefNum', 'xAuthCode', 'xMaskedCardNumber', 'xCardType', 'xExp', 'xBatch'];
  const kept = Object.fromEntries(keep.filter(k => result[k] !== undefined).map(k => [k, result[k]]));
  const g = await rpc('record_gateway_result', { p_org: c.org_id, p_id: c.id, p_result: kept });
  return g.status as string;
}

Deno.serve(async req => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const token = req.headers.get('x-cron-token') ?? '';
  if (!token || await rpc('check_cron_token', { p_token: token }) !== true) return new Response('Forbidden', { status: 403 });
  const tally: Record<string, number> = {};
  for (let round = 0; round < 10; round++) {
    const due = await rpc('claim_recurring_charges', { p_limit: 25 }) as Due[];
    if (!due.length) break;
    for (const c of due) {
      let status: string;
      try { status = await charge(c); } catch (e) { console.error(e); status = 'failed_to_record'; }
      tally[status] = (tally[status] ?? 0) + 1;
    }
  }
  return Response.json(tally);
});
