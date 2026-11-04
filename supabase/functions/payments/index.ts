// Charges, voids and refunds through Sola Payments with the organization's own API key. Called by a signed-in
// admin from the portal; JWT verification stays on. The admin's request is checked and recorded by the
// database as them first, then this function, which alone can read the key, talks to Sola and records the answer.
// Card numbers arrive only as iFields single-use tokens.

const url = Deno.env.get('SUPABASE_URL')!;
const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const GATEWAY = 'https://x1.cardknox.com/gatewayjson';

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

interface Body {
  action: 'sale' | 'void' | 'refund' | 'save';
  org: string;
  campaign_id?: string; donor_id?: string | null; amount?: number; card_id?: string | null; save_card?: boolean;
  name?: string; email?: string; notes?: string; zip?: string; street?: string;
  card_sut?: string; cvv_sut?: string; exp?: string;
  donation_id?: string;
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply({ error: 'Method not allowed' }, 405);
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  let b: Body;
  try { b = await req.json(); } catch { return reply({ error: 'Bad request' }, 400); }
  if (!b.org) return reply({ error: 'Missing organization' }, 400);
  const user = { token, org: b.org };
  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || null;

  if ((b.action === 'save' || (b.action === 'sale' && !b.card_id)) && (!b.card_sut || !b.cvv_sut || !/^\d{4}$/.test(b.exp ?? ''))) {
    return reply({ error: 'Enter the card number, expiry (MMYY) and CVV' });
  }

  // 1. The database checks the admin and records the attempt, as them.
  let id: string;
  try {
    id = b.action === 'sale'
      ? await rpc('begin_card_sale', {
          p_campaign: b.campaign_id, p_donor: b.donor_id ?? null, p_amount: b.amount, p_card: b.card_id ?? null,
          p_save_card: !!b.save_card, p_name: b.name ?? null, p_email: b.email ?? null, p_notes: b.notes ?? null, p_ip: ip,
        }, user)
      : b.action === 'save'
        ? await rpc('begin_card_save', { p_donor: b.donor_id, p_name: b.name ?? null, p_ip: ip }, user)
        : await rpc('begin_card_reversal', { p_donation: b.donation_id, p_kind: b.action }, user);
  } catch (e) {
    return reply({ error: e instanceof Error ? e.message : String(e) });
  }
  // 2. Only this function can read the organization's key.
  let c: Record<string, any>;
  try {
    [c] = await rpc('claim_gateway_request', { p_org: b.org, p_id: id }, null);
  } catch (e) {
    return reply({ error: e instanceof Error ? e.message : String(e) });
  }
  if (!c?.api_key) return reply({ error: 'The Sola API key is missing' });

  // 3. Sola.
  const base = { xKey: c.api_key, xVersion: '5.0.0', xSoftwareName: 'Oizer CRM', xSoftwareVersion: '1.0', xInvoice: c.invoice, xIP: ip ?? undefined };
  const command = c.kind === 'save'
    ? { ...base, xCommand: 'cc:save', xCardNum: b.card_sut, xCVV: b.cvv_sut, xExp: b.exp, xName: c.card_name ?? undefined, xBillZip: b.zip || undefined }
    : c.kind === 'sale'
    ? {
        ...base, xCommand: 'cc:sale', xAmount: Number(c.amount).toFixed(2),
        ...(c.card_token ? { xToken: c.card_token } : { xCardNum: b.card_sut, xCVV: b.cvv_sut, xExp: b.exp }),
        xName: c.card_name ?? undefined, xEmail: c.email ?? undefined, xBillZip: b.zip || undefined, xBillStreet: b.street || undefined,
        xDescription: c.campaign_label ?? undefined,
      }
    // A refund uses cc:voidrefund: before the batch settles it voids the charge, after it refunds it, so it works any time.
    : { ...base, xCommand: c.kind === 'void' ? 'cc:void' : 'cc:voidrefund', xRefNum: c.original_ref };
  let result: Record<string, string>;
  try {
    const res = await fetch(GATEWAY, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command), signal: AbortSignal.timeout(45000) });
    result = await res.json();
  } catch (e) {
    // The answer was lost. The transaction stays pending; Sola's webhook will finish it if it went through.
    return reply({ error: `No answer from Sola (${e instanceof Error ? e.message : e}). Check the transaction before trying again.`, pending: true, id });
  }

  // 4. The database records the answer as the admin: a donation, a decline, a void or a refund.
  try {
    const keep = ['xResult', 'xStatus', 'xError', 'xErrorCode', 'xRefNum', 'xAuthCode', 'xMaskedCardNumber', 'xCardType', 'xExp',
      'xAvsResult', 'xCvvResult', 'xBatch', 'xAuthAmount', 'xToken'];
    const kept = Object.fromEntries(keep.filter(k => result[k] !== undefined).map(k => [k, result[k]]));
    const g = await rpc('record_gateway_result', { p_org: b.org, p_id: id, p_result: kept }, null);
    return reply({ transaction: g });
  } catch (e) {
    return reply({ error: `Sola answered ${result.xStatus ?? '?'} (ref ${result.xRefNum ?? '?'}), but saving it failed: ${e instanceof Error ? e.message : e}`, id });
  }
});
