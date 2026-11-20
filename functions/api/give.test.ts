import { afterEach, describe, expect, it, vi } from 'vitest';
import { onRequestPost } from './give';

// Moshe Henig, 2026-11-11: the payment page posts to its own site, which passes the gift on to the gate.
describe('payment page site function', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('passes the gift to the gate with the donor’s address and the site’s proof, and returns the reply as is', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response('{"approved":true,"ref":"R1"}', { status: 200 }); });
    const res = await onRequestPost({
      request: new Request('https://oizer.trubase.org/api/give', { method: 'POST', body: '{"org":"o","campaign":"1"}', headers: { Origin: 'https://oizer.trubase.org', 'cf-connecting-ip': '9.9.9.9' } }),
      env: { GIVE_GATE_SECRET: 's3cret' },
    });
    expect(await res.json()).toEqual({ approved: true, ref: 'R1' });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(calls[0].url).toBe('https://oizer-give-gate.smueller-cd9.workers.dev/');
    const h = calls[0].init.headers as Record<string, string>;
    expect(h).toMatchObject({ Origin: 'https://oizer.trubase.org', 'x-oizer-gate-proxy': 's3cret', 'x-oizer-client-ip': '9.9.9.9' });
  });

  it('says plainly when the gate can’t be reached', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('down'); });
    const res = await onRequestPost({ request: new Request('https://oizer.trubase.org/api/give', { method: 'POST', body: '{}' }), env: {} });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ unreachable: true });
  });
});
