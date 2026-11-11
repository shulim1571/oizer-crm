// Gifts from a campaign's public payment page: by card, bank account (ACH) or DAF card. No sign-in: deployed
// with JWT verification off. Each request must pass Cloudflare Turnstile with the organization's own secret key,
// or the platform's (TURNSTILE_SECRET_KEY) when it has none; with neither, the page can't take payments, sandbox
// keys or not. Requests reach this function through the rate-limiting gate (workers/give-gate); once
// GIVE_GATE_SECRET is set, anything else is refused. The database then checks the page's rules, the method and
// the connection's recent attempts, and the organization's own Sola key charges the gift.
import { fundCardMessage, fundCvvOk, fundCvvProblem } from '../_shared/fundCards.ts';
import { botCheckDecision, donorProblem, gateCheck } from '../_shared/giveGuard.ts';

const url = Deno.env.get('SUPABASE_URL')!;
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const platformTurnstileSecret = Deno.env.get('TURNSTILE_SECRET_KEY') ?? null;
const gateSecret = Deno.env.get('GIVE_GATE_SECRET') ?? null;
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

async function humanCheck(org: string, token: string | undefined, ip: string | null): Promise<'ok' | 'not_set_up' | 'failed'> {
  const own = await rpc('org_turnstile_secret', { p_org: org }).catch(() => null) as string | null;
  const turnstileSecret = own ?? platformTurnstileSecret;
  const decision = botCheckDecision(turnstileSecret, token);
  if (decision === 'not_set_up') return 'not_set_up';
  if (decision === 'no_token') return 'failed';
  const form = new URLSearchParams({ secret: turnstileSecret!, response: token!, ...(ip ? { remoteip: ip } : {}) });
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form }).catch(() => null);
  const body = res ? await res.json().catch(() => ({})) : {};
  return body.success === true ? 'ok' : 'failed';
}

const COUNTRY: Record<string, string> = { USA: 'US', Canada: 'CA', Israel: 'IL', England: 'GB' };

// ---------------------------------------------------------------------------
// Payment methods: card, bank account (ACH) or DAF card. The same block is in the payments, give and
// recurring-charges functions. Bank and DAF numbers pass through to Sola; they're never stored or logged.
// ---------------------------------------------------------------------------
interface Pay {
  method?: 'card' | 'ach' | 'daf'; program?: string;
  card_sut?: string; cvv_sut?: string; exp?: string;
  routing?: string; account?: string; account_type?: string; account_name?: string;
  daf_card?: string; daf_exp?: string; daf_cvv?: string; daf_email?: string; daf_pin?: string;
}

// The ABA checksum every US routing number passes.
const routingOk = (r: string) => /^\d{9}$/.test(r) && [...r].reduce((s, d, i) => s + Number(d) * [3, 7, 1][i % 3], 0) % 10 === 0;

// What each fund asks for, as on the organization's existing page. Donors Fund also signs in by email and PIN.
const DAF_NEEDS: Record<string, { exp: boolean; cvv: boolean }> = {
  OJC: { exp: true, cvv: false }, Pledger: { exp: true, cvv: true }, Matbia: { exp: true, cvv: false }, 'Donors Fund': { exp: false, cvv: true },
};

function payProblem(p: Pay): string | null {
  const m = p.method ?? 'card';
  if (m === 'card') return p.card_sut && p.cvv_sut && /^\d{4}$/.test(p.exp ?? '') ? null : 'Enter the card number, expiry and CVV.';
  if (m === 'ach') {
    if (!routingOk(p.routing ?? '')) return 'Check the routing number.';
    if (!/^\d{4,17}$/.test(p.account ?? '')) return 'Check the account number.';
    if (!['Checking', 'Savings'].includes(p.account_type ?? '')) return 'Choose checking or savings.';
    return null;
  }
  const need = DAF_NEEDS[p.program ?? ''];
  if (!need) return 'Choose the fund.';
  if (p.program === 'Donors Fund' && p.daf_email) {
    return /^\S+@\S+\.\S+$/.test(p.daf_email) && /^\d{4}$/.test(p.daf_pin ?? '') ? null : 'Enter the Donors Fund email and 4-digit PIN.';
  }
  if (!/^\d{8,19}$/.test(p.daf_card ?? '')) return `Check the ${p.program} card number.`;
  if (need.exp && !/^\d{4}$/.test(p.daf_exp ?? '')) return 'Enter the expiry as MM/YY.';
  if (need.cvv && !fundCvvOk(p.program, p.daf_cvv)) return fundCvvProblem(p.program);
  return null;
}

/** The method's part of a Sola request: the command, and the account, card or saved token. */
function solaFields(method: string, kind: string, p: Pay, token: string | null, ref?: string | null, accountType?: string | null): Record<string, unknown> {
  const family = method === 'ach' ? 'check' : method === 'daf' ? 'grant' : 'cc';
  if (kind === 'void') return { xCommand: family === 'grant' ? 'grant:Void' : `${family}:void`, xRefNum: ref };
  // A card refund uses cc:voidrefund: before the batch settles it voids the charge, after it refunds it.
  if (kind === 'refund') return { xCommand: family === 'check' ? 'check:refund' : 'cc:voidrefund', xRefNum: ref };
  const xCommand = family === 'grant' ? 'grant:Recommendation' : `${family}:${kind}`;
  if (token) return { xCommand, xToken: token };
  if (family === 'check') return { xCommand, xRouting: p.routing, xAccount: p.account, xAccountType: accountType ?? p.account_type, xName: p.account_name };
  if (family === 'grant') {
    // Donors Fund by account sends the email and PIN in the card fields; to confirm in Sola's sandbox.
    return p.daf_email ? { xCommand, xCardNum: p.daf_email, xCVV: p.daf_pin }
      : { xCommand, xCardNum: p.daf_card, xExp: p.daf_exp || undefined, xCVV: p.daf_cvv || undefined };
  }
  return { xCommand, xCardNum: p.card_sut, xCVV: p.cvv_sut, xExp: p.exp };
}

/** The donor's bank authorization as the database keeps it: never the numbers, only type and last four. */
const achConsent = (p: Pay, agreed: boolean) =>
  p.method === 'ach' ? { account_type: p.account_type, last4: (p.account ?? '').slice(-4), name: p.account_name, agreed } : null;

const KEEP = ['xResult', 'xStatus', 'xError', 'xErrorCode', 'xRefNum', 'xAuthCode', 'xMaskedCardNumber', 'xMaskedAccountNumber', 'xCardType', 'xExp',
  'xAvsResult', 'xCvvResult', 'xBatch', 'xAuthAmount', 'xToken'];
const kept = (result: Record<string, string>) => Object.fromEntries(KEEP.filter(k => result[k] !== undefined).map(k => [k, result[k]]));

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply({ error: 'Method not allowed' });
  const gate = gateCheck(gateSecret, req.headers);
  if (!gate.ok) return Response.json({ error: 'Please use the campaign\'s payment page.' }, { status: 403, headers: CORS });
  const ip = gate.ip;
  let b: Record<string, any> & Pay;
  try { b = await req.json(); } catch { return reply({ error: 'Something went wrong. Please try again.' }); }
  b.method ??= 'card';
  if (!b.org || !b.campaign) return reply({ error: 'Something went wrong. Please try again.' });
  const problem = payProblem(b);
  if (problem) return reply({ error: problem });

  let page: Record<string, any> | null;
  try {
    page = await rpc('public_give_page', { p_org: b.org, p_campaign: b.campaign });
  } catch {
    return reply({ error: 'This page isn\'t available right now. Please try again shortly.' });
  }
  if (!page) return reply({ error: 'This page isn\'t taking donations.' });
  const human = await humanCheck(b.org, b.turnstile, ip);
  if (human === 'not_set_up') return reply({ error: 'This page isn\'t taking online donations yet. Please contact the organization.', not_set_up: true });
  if (human !== 'ok') return reply({ error: 'Please confirm you\'re not a robot and try again.', retry_check: true });

  const missing = donorProblem(b.donor);
  if (missing) return reply({ error: missing });

  // 1. The page's rules, the method and the connection's limits.
  let start: { id: string; token: string; total: number; kind: 'sale' | 'save' };
  try {
    start = await rpc('begin_public_payment', {
      p_org: b.org, p_campaign: b.campaign, p_amount: Number(b.amount), p_cover_fee: !!b.cover_fee,
      p_donor: b.donor ?? {}, p_custom: b.custom ?? {}, p_ip: ip, p_recurring: b.recurring ?? null,
      p_method: b.method, p_program: b.method === 'daf' ? b.program : null, p_ach: achConsent(b, !!b.ach_agreed),
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
  // A recurring donation starting later only saves the card or account now; its first charge comes on the start date.
  const later = start.kind === 'save';
  const command = {
    xKey: c.api_key, xVersion: '5.0.0', xSoftwareName: 'Oizer CRM', xSoftwareVersion: '1.0',
    ...solaFields(c.method, later ? 'save' : 'sale', b, null),
    ...(later ? {} : { xAmount: Number(c.amount).toFixed(2) }), xInvoice: c.invoice, xIP: ip ?? undefined,
    xBillFirstName: d.first_name, xBillLastName: d.last_name, xBillPhone: d.phone, xEmail: d.email || undefined,
    xBillStreet: d.address || undefined, xBillZip: d.zip || undefined, xBillCountry: COUNTRY[d.country] ?? undefined,
    xDescription: c.campaign_label ?? undefined,
  };
  let result: Record<string, string>;
  try {
    const res = await fetch(GATEWAY, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command), signal: AbortSignal.timeout(45000) });
    result = await res.json();
  } catch {
    return reply({ error: 'We didn\'t hear back from the payment processor. Please don\'t try again yet: the office will check whether your gift went through.', pending: true });
  }

  // 4. Recorded: a donation, or a failed attempt.
  try {
    const g = await rpc('record_gateway_result', { p_org: b.org, p_id: start.id, p_result: kept(result) });
    if (g.status !== 'approved') {
      return reply({ declined: true, error: b.method === 'daf' ? fundCardMessage(b.program, result) : result.xError || (b.method === 'card' ? 'The card was declined. Please check the details or try another card.' : 'The payment wasn\'t accepted. Please check the details.') });
    }
    const last4 = String(g.masked_card ?? '').slice(-4);
    return reply({
      approved: true, method: c.method, scheduled: later, recurring: !!b.recurring, recurring_set: !b.recurring || !!g.recurring_id,
      start: b.recurring?.start ?? null, amount: later ? 0 : g.amount, per: c.amount, ref: g.ref_num,
      card: c.method === 'ach' ? `${g.card_type ?? 'Bank'} ••${last4}` : c.method === 'daf' ? `${c.daf_program}${last4 ? ` ••${last4}` : ''}` : `${g.card_type ?? 'Card'} ${last4}`,
      token: later ? null : start.token,
    });
  } catch {
    return reply({ approved: true, method: c.method, amount: c.amount, ref: result.xRefNum, token: start.token });
  }
});
