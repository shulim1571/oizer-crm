import { describe, expect, it, vi } from 'vitest';
import { handleMakeIngest, makeRpc } from './makeIngest';

const ORG = '00000000-0000-4000-8000-000000000001';
const req = (qs: string, init: RequestInit = {}) => new Request(`https://x.supabase.co/functions/v1/make-ingest?${qs}`, { method: 'POST', ...init });

describe('make-ingest function', () => {
  it('passes org, source, key and body to make_ingest and answers with its status', async () => {
    const rpc = vi.fn(async () => ({ ok: true, status: 201, outcome: 'created', record_id: 'MK-1' }));
    const res = await handleMakeIngest(req(`org=${ORG}&source=sola`, { headers: { 'x-donorbase-key': 'k1', 'content-type': 'application/json' }, body: JSON.stringify({ xAmount: '5' }) }), rpc);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, outcome: 'created', record_id: 'MK-1' });
    expect(rpc).toHaveBeenCalledWith('make_ingest', { p_org: ORG, p_key: 'k1', p_source: 'sola', p_body: { xAmount: '5' } });
  });

  it('accepts form fields and a one-item bundle array', async () => {
    const rpc = vi.fn(async () => ({ ok: true, status: 200 }));
    await handleMakeIngest(req(`org=${ORG}&source=sola`, { headers: { 'x-donorbase-key': 'k', 'content-type': 'application/x-www-form-urlencoded' }, body: 'xAmount=5&xCommand=cc%3Asale' }), rpc);
    await handleMakeIngest(req(`org=${ORG}&source=elevon`, { headers: { 'x-donorbase-key': 'k' }, body: JSON.stringify([{ amount: 3 }]) }), rpc);
    expect((rpc.mock.calls[0] as any)[1].p_body).toEqual({ xAmount: '5', xCommand: 'cc:sale' });
    expect((rpc.mock.calls[1] as any)[1].p_body).toEqual({ amount: 3 });
  });

  it('rejects without calling the database: wrong method, bad org or source, no key, bad body', async () => {
    const rpc = vi.fn();
    expect((await handleMakeIngest(new Request(`https://x/?org=${ORG}&source=sola`), rpc)).status).toBe(405);
    expect((await handleMakeIngest(req(`org=nope&source=sola`, { headers: { 'x-donorbase-key': 'k' }, body: '{}' }), rpc)).status).toBe(400);
    expect((await handleMakeIngest(req(`org=${ORG}&source=paypal`, { headers: { 'x-donorbase-key': 'k' }, body: '{}' }), rpc)).status).toBe(400);
    expect((await handleMakeIngest(req(`org=${ORG}&source=sola&key=k`, { body: '{}' }), rpc)).status).toBe(401);   // not from the query string
    expect((await handleMakeIngest(req(`org=${ORG}&source=sola`, { headers: { 'x-donorbase-key': 'k' }, body: 'not json' }), rpc)).status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('passes on a refusal status (wrong key) and answers 503 when the database is unreachable', async () => {
    const no = await handleMakeIngest(req(`org=${ORG}&source=elevon`, { headers: { 'x-donorbase-key': 'bad' }, body: '{}' }), async () => ({ ok: false, status: 401, error: 'Not authorized' }));
    expect(no.status).toBe(401);
    const down = await handleMakeIngest(req(`org=${ORG}&source=elevon`, { headers: { 'x-donorbase-key': 'k' }, body: '{}' }), async () => { throw new Error('x'); });
    expect(down.status).toBe(503);
  });

  it('rpc reads text, so a 204 with an empty body is fine', async () => {
    const f = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    await expect(makeRpc('https://x', 's', f)('anything', {})).resolves.toBeNull();
    const g = vi.fn(async () => new Response(JSON.stringify({ message: 'boom' }), { status: 400 })) as unknown as typeof fetch;
    await expect(makeRpc('https://x', 's', g)('anything', {})).rejects.toThrow('boom');
  });
});
