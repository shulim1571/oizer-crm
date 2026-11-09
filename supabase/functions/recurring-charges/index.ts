// Charges recurring donations that are due, each organization with its own Sola key and the donor's saved card,
// bank account or DAF card token. The database calls this every hour, and when the office resumes or retries one,
// with a token only it knows. Deployed with JWT verification off. Each charge's answer is recorded in one step:
// the donation, and the schedule moved on or its retry set.

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
  if (need.cvv && !/^\d{3,4}$/.test(p.daf_cvv ?? '')) return 'Enter the CVV.';
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

interface Due {
  org_id: string; id: string; invoice: string; amount: number; api_key: string; card_token: string | null; campaign_label: string | null;
  card_name: string | null; email: string | null; method: string; daf_program: string | null;
}

async function charge(c: Due) {
  let result: Record<string, string>;
  if (!c.card_token) {
    result = { xResult: 'E', xError: c.method === 'ach' ? 'The saved bank account is no longer on file' : 'The saved card is no longer on file' };
  } else {
    try {
      const res = await fetch(GATEWAY, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(45000),
        body: JSON.stringify({
          xKey: c.api_key, xVersion: '5.0.0', xSoftwareName: 'Oizer CRM', xSoftwareVersion: '1.0',
          ...solaFields(c.method, 'sale', {}, c.card_token),
          xAmount: Number(c.amount).toFixed(2), xInvoice: c.invoice, xName: c.card_name ?? undefined,
          xEmail: c.email ?? undefined, xDescription: c.campaign_label ? `Recurring: ${c.campaign_label}` : 'Recurring donation',
        }),
      });
      result = await res.json();
    } catch {
      // No answer: the charge stays pending for an hour, then Sola's webhook or the next run settles it.
      return 'pending';
    }
  }
  const g = await rpc('record_gateway_result', { p_org: c.org_id, p_id: c.id, p_result: kept(result) });
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
