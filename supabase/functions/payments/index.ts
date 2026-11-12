// Charges, saves, voids and refunds through Sola Payments with the organization's own API key: cards, bank
// accounts (ACH) and DAF cards. Called by a signed-in admin from the portal; JWT verification stays on. The
// admin's request is checked and recorded by the database as them first, then this function, which alone can
// read the key, talks to Sola and records the answer. Card numbers arrive only as iFields single-use tokens;
// bank and DAF numbers pass through to Sola and are never stored.

import { fundCvvOk, fundCvvProblem } from '../_shared/fundCards.ts';
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

interface Body extends Pay {
  action: 'sale' | 'void' | 'refund' | 'save';
  org: string;
  campaign_id?: string; donor_id?: string | null; amount?: number; card_id?: string | null; save_card?: boolean;
  name?: string; email?: string; notes?: string; zip?: string; street?: string;
  ach_authorized?: boolean;
  donation_id?: string;
  /** A fundraiser's card payment from New Donation: a new card only, to their own campaign (checked by the database). */
  as_fundraiser?: boolean;
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
  b.method ??= 'card';
  // A fundraiser's sale (Moshe Henig, 2026-11-12): only a card typed in now. Nothing saved, no saved card, no donor
  // record, no bank or fund payment, whatever the request says; the database checks the campaign is theirs.
  if (b.as_fundraiser) {
    if (b.action !== 'sale') return reply({ error: 'Fundraisers can only take a card payment' }, 403);
    b.method = 'card'; b.card_id = null; b.save_card = false; b.donor_id = null; delete b.program;
  }

  if (b.action === 'save' || (b.action === 'sale' && !b.card_id)) {
    const problem = payProblem(b);
    if (problem) return reply({ error: problem });
  }

  // 1. The database checks the admin and records the attempt, as them.
  let id: string;
  try {
    id = b.as_fundraiser
      ? await rpc('begin_fundraiser_card_sale', {
          p_campaign: b.campaign_id, p_amount: b.amount, p_name: b.name ?? null, p_email: b.email ?? null, p_notes: b.notes ?? null, p_ip: ip,
        }, user)
      : b.action === 'sale'
      ? await rpc('begin_admin_payment', {
          p_method: b.method, p_program: b.program ?? null, p_campaign: b.campaign_id, p_donor: b.donor_id ?? null, p_amount: b.amount,
          p_card: b.card_id ?? null, p_save: !!b.save_card, p_name: b.name ?? null, p_email: b.email ?? null, p_notes: b.notes ?? null, p_ip: ip,
          p_ach: achConsent(b, !!b.ach_authorized),
        }, user)
      : b.action === 'save'
        ? await rpc('begin_admin_save', { p_method: b.method, p_donor: b.donor_id, p_name: b.name ?? null, p_ip: ip, p_ach: achConsent(b, !!b.ach_authorized) }, user)
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
  const fields = solaFields(c.method, c.kind, b, c.card_token, c.original_ref, c.account_type);
  const command = c.kind === 'save'
    ? { ...base, ...fields, xName: fields.xName ?? c.card_name ?? undefined, xBillZip: b.zip || undefined }
    : c.kind === 'sale'
    ? {
        ...base, ...fields, xAmount: Number(c.amount).toFixed(2),
        xName: fields.xName ?? c.card_name ?? undefined, xEmail: c.email ?? undefined, xBillZip: b.zip || undefined, xBillStreet: b.street || undefined,
        xDescription: c.campaign_label ?? undefined,
      }
    : { ...base, ...fields };
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
    const g = await rpc('record_gateway_result', { p_org: b.org, p_id: id, p_result: kept(result) }, null);
    return reply({ transaction: g });
  } catch (e) {
    return reply({ error: `Sola answered ${result.xStatus ?? '?'} (ref ${result.xRefNum ?? '?'}), but saving it failed: ${e instanceof Error ? e.message : e}`, id });
  }
});
