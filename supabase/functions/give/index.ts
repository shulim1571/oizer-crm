// Gifts from a campaign's public payment page. No sign-in: deployed with JWT verification off. Each request
// passes Cloudflare Turnstile (TURNSTILE_SECRET_KEY), except while an organization is on sandbox keys and no
// Turnstile secret is set yet. The database checks the page's rules and the connection's recent attempts,
// then the organization's own Sola key charges the card tokens from iFields.

const url = Deno.env.get('SUPABASE_URL')!;
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const turnstileSecret = Deno.env.get('TURNSTILE_SECRET_KEY');
const GATEWAY = 'https://x1.cardknox.com/gatewayjson';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (body: unknown) => Response.json(body, { headers: CORS });

async function rpc(name: string, args: unknown) {
  const res = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.message ?? `${name} failed (${res.status})`);
  return body;
}

async function humanCheck(token: string | undefined, ip: string | null, sandbox: boolean) {
  if (!turnstileSecret) return sandbox;
  if (!token) return false;
  const form = new URLSearchParams({ secret: turnstileSecret, response: token, ...(ip ? { remoteip: ip } : {}) });
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
  const body = await res.json().catch(() => ({}));
  return body.success === true;
}

const COUNTRY: Record<string, string> = { USA: 'US', Canada: 'CA', Israel: 'IL', England: 'GB' };

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply({ error: 'Method not allowed' });
  let b: Record<string, any>;
  try { b = await req.json(); } catch { return reply({ error: 'Something went wrong. Please try again.' }); }
  const ip = (req.headers.get('cf-connecting-ip') ?? req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || null;
  if (!b.org || !b.campaign || !b.card_sut || !b.cvv_sut || !/^\d{4}$/.test(String(b.exp ?? ''))) {
    return reply({ error: 'Enter the card number, expiry and CVV.' });
  }

  let page: Record<string, any> | null;
  try {
    page = await rpc('public_give_page', { p_org: b.org, p_campaign: b.campaign });
  } catch {
    return reply({ error: 'This page isn\'t available right now. Please try again shortly.' });
  }
  if (!page) return reply({ error: 'This page isn\'t taking donations.' });
  if (!await humanCheck(b.turnstile, ip, page.payments?.sandbox)) return reply({ error: 'Please confirm you\'re not a robot and try again.', retry_check: true });

  // 1. The page's rules and the connection's limits.
  let start: { id: string; token: string; total: number; kind: 'sale' | 'save' };
  try {
    start = await rpc('begin_public_sale', {
      p_org: b.org, p_campaign: b.campaign, p_amount: Number(b.amount), p_cover_fee: !!b.cover_fee,
      p_donor: b.donor ?? {}, p_custom: b.custom ?? {}, p_ip: ip, p_recurring: b.recurring ?? null,
    });
  } catch (e) {
    return reply({ error: e instanceof Error ? e.message : String(e) });
  }

  // 2. The organization's key.
  let c: Record<string, any>;
  try {
    [c] = await rpc('claim_gateway_request', { p_org: b.org, p_id: start.id });
  } catch {
    return reply({ error: 'Something went wrong. Please try again.' });
  }

  // 3. Sola.
  const d = b.donor ?? {};
  // A recurring donation starting later only saves the card now; its first charge comes on the start date.
  const later = start.kind === 'save';
  const command = {
    xKey: c.api_key, xVersion: '5.0.0', xSoftwareName: 'Oizer CRM', xSoftwareVersion: '1.0', xCommand: later ? 'cc:save' : 'cc:sale',
    ...(later ? {} : { xAmount: Number(c.amount).toFixed(2) }), xInvoice: c.invoice, xIP: ip ?? undefined,
    xCardNum: b.card_sut, xCVV: b.cvv_sut, xExp: b.exp,
    xBillFirstName: d.first_name, xBillLastName: d.last_name, xBillPhone: d.phone, xEmail: d.email || undefined,
    xBillStreet: d.address || undefined, xBillZip: d.zip || undefined, xBillCountry: COUNTRY[d.country] ?? undefined,
    xDescription: c.campaign_label ?? undefined,
  };
  let result: Record<string, string>;
  try {
    const res = await fetch(GATEWAY, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command), signal: AbortSignal.timeout(45000) });
    result = await res.json();
  } catch {
    return reply({ error: 'We didn\'t hear back from the card processor. Please don\'t try again yet: the office will check whether your gift went through.', pending: true });
  }

  // 4. Recorded: a donation, or a failed attempt.
  try {
    const keep = ['xResult', 'xStatus', 'xError', 'xErrorCode', 'xRefNum', 'xAuthCode', 'xMaskedCardNumber', 'xCardType', 'xExp', 'xAvsResult', 'xCvvResult', 'xBatch', 'xToken'];
    const kept = Object.fromEntries(keep.filter(k => result[k] !== undefined).map(k => [k, result[k]]));
    const g = await rpc('record_gateway_result', { p_org: b.org, p_id: start.id, p_result: kept });
    if (g.status !== 'approved') return reply({ declined: true, error: result.xError || 'The card was declined. Please check the details or try another card.' });
    return reply({ approved: true, scheduled: later, recurring: !!b.recurring, start: b.recurring?.start ?? null, amount: later ? 0 : g.amount, per: c.amount, ref: g.ref_num,
                   card: `${g.card_type ?? 'Card'} ${String(g.masked_card ?? '').slice(-4)}`, token: later ? null : start.token });
  } catch {
    return reply({ approved: true, amount: c.amount, ref: result.xRefNum, token: start.token });
  }
});
