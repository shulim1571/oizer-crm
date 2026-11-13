import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Moshe Henig, 2026-11-11: a payment page retry after an error (when the gift had gone through) charged again.
// Runs the real give function with Sola, the bot check and the database faked.
const BASE = 'https://example.supabase.co';
let handler: (req: Request) => Promise<Response>;
let attempts: { id: string; key: string | null; status: string }[];
let solaCharges: number;

const give = (body: Record<string, unknown>) =>
  handler(new Request('http://localhost/give', {
    method: 'POST', headers: { 'x-give-gate': 'gate-secret', 'x-oizer-client-ip': '1.2.3.4' },
    body: JSON.stringify({ org: 'org', campaign: '1012', amount: 10, donor: { first_name: 'A', last_name: 'B', phone: '8455550100', zip: '10952', country: 'USA' },
      method: 'card', card_sut: 'sut', cvv_sut: 'sut', exp: '1230', turnstile: 'tok', ...body }),
  })).then(r => r.json());

beforeAll(async () => {
  (globalThis as any).Deno = {
    env: { get: (k: string) => ({ SUPABASE_URL: BASE, SUPABASE_SERVICE_ROLE_KEY: 'svc', GIVE_GATE_SECRET: 'gate-secret', TURNSTILE_SECRET_KEY: 'ts' } as Record<string, string>)[k] },
    serve: (h: typeof handler) => { handler = h; },
  };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const ok = (v: unknown, status = 200) => new Response(v === undefined ? null : JSON.stringify(v), { status });
    if (url.includes('turnstile')) return ok({ success: true });
    if (url.includes('cardknox')) { solaCharges++; return ok({ xResult: 'A', xStatus: 'Approved', xRefNum: 'R' + solaCharges, xMaskedCardNumber: '4xxxxxxxxxxx1111', xCardType: 'Visa' }); }
    const name = url.split('/rpc/')[1];
    const args = JSON.parse(String(init.body));
    switch (name) {
      case 'public_give_page': return ok({ campaign: { id: '1012' } });
      case 'org_turnstile_secret': return ok(null);
      case 'public_payment_attempt': {
        const a = [...attempts].reverse().find(x => x.key === args.p_key);
        return ok(a ? { status: a.status, kind: 'sale', amount: 10.45, method: 'card', ref: 'R1', card_type: 'Visa', masked_card: '4xxxxxxxxxxx1111', token: 'pt' } : null);
      }
      case 'begin_public_payment': { const id = 'g' + (attempts.length + 1); attempts.push({ id, key: null, status: 'pending' }); return ok({ id, token: 'pt', total: 10.45, kind: 'sale' }); }
      case 'tag_payment_attempt': { attempts.find(x => x.id === args.p_id)!.key = args.p_key; return ok(undefined, 204); }
      case 'claim_gateway_request': return ok([{ api_key: 'k', method: 'card', amount: 10.45, invoice: 'OZ1' }]);
      case 'record_gateway_result': { attempts.find(x => x.id === args.p_id)!.status = 'approved'; return ok({ status: 'approved', amount: 10.45, ref_num: 'R1', masked_card: '4xxxxxxxxxxx1111', card_type: 'Visa' }); }
      default: throw new Error('unexpected rpc ' + name);
    }
  });
  await import('../give/index.ts');
});
beforeEach(() => { attempts = []; solaCharges = 0; });

describe('payment page retries', () => {
  const KEY = '0f8e2b7c-1d3a-4c5e-9f00-123456789abc';

  it('charge once: a retry with the same key gets the same success, not a second charge', async () => {
    const first = await give({ client_key: KEY });
    expect(first).toMatchObject({ approved: true, ref: 'R1' });
    const again = await give({ client_key: KEY, turnstile: 'tok2' });
    expect(again).toMatchObject({ approved: true, repeat: true, card: 'Visa 1111' });
    expect(solaCharges).toBe(1);
  });

  it('tell the page what happened when its reply was lost', async () => {
    await give({ client_key: KEY });
    expect(await give({ client_key: KEY, status_only: true, card_sut: undefined })).toMatchObject({ approved: true });
    expect(await give({ client_key: 'ffffffff-ffff-4fff-8fff-ffffffffffff', status_only: true })).toEqual({ unknown: true });
    expect(solaCharges).toBe(1);
  });

  it('do not start a second charge while the first is still in progress', async () => {
    attempts.push({ id: 'g0', key: KEY, status: 'pending' });
    expect(await give({ client_key: KEY })).toMatchObject({ pending: true });
    expect(solaCharges).toBe(0);
  });

  it('a new gift (new key) is charged normally', async () => {
    await give({ client_key: KEY });
    await give({ client_key: '11111111-2222-4333-8444-555555555555' });
    expect(solaCharges).toBe(2);
  });
});
