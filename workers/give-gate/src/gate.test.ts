import { describe, expect, it } from 'vitest';
import { allowedOrigin, handle, ipKey, type GateEnv, type Limiter } from './gate';

/** A limiter that allows `max` calls per key, like the binding within one location. */
const limiter = (max: number): Limiter & { seen: string[] } => {
  const counts = new Map<string, number>();
  const seen: string[] = [];
  return { seen, async limit({ key }) { seen.push(key); const n = (counts.get(key) ?? 0) + 1; counts.set(key, n); return { success: n <= max }; } };
};
const env = (over: Partial<GateEnv> = {}): GateEnv => ({
  PER_IP: limiter(8), PER_CAMPAIGN: limiter(60), SUPABASE_URL: 'https://example.supabase.co/', SUPABASE_ANON_KEY: 'anon',
  GIVE_GATE_SECRET: 'gate-secret', ALLOWED_ORIGINS: 'oizer.trubase.org,*.oizer-drm.pages.dev,localhost', ...over,
});
const post = (body: object, ip = '1.2.3.4', origin = 'https://oizer.trubase.org') =>
  new Request('https://gate.example/', { method: 'POST', headers: { Origin: origin, 'cf-connecting-ip': ip, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const GIFT = { org: 'o1', campaign: '1002', amount: 18 };

describe('give gate', () => {
  it('forwards a payment to the give function with the gate secret and the donor IP', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response('{"approved":true}', { headers: { 'Content-Type': 'application/json' } }); }) as unknown as typeof fetch;
    const res = await handle(post(GIFT), env(), fetcher);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ approved: true });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://oizer.trubase.org');
    expect(calls[0].url).toBe('https://example.supabase.co/functions/v1/give');
    const h = calls[0].init.headers as Record<string, string>;
    expect(h['x-give-gate']).toBe('gate-secret');
    expect(h['x-oizer-client-ip']).toBe('1.2.3.4');
    expect(JSON.parse(String(calls[0].init.body))).toEqual(GIFT);
  });

  it('stops a connection after 8 tries a minute, without touching the give function', async () => {
    let forwarded = 0;
    const fetcher = (async () => { forwarded++; return new Response('{}'); }) as unknown as typeof fetch;
    const e = env();
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) statuses.push((await handle(post(GIFT), e, fetcher)).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 429, 429]);
    expect(forwarded).toBe(8);
    const blocked = await handle(post(GIFT), e, fetcher);
    expect(blocked.headers.get('Retry-After')).toBe('60');
    expect(await blocked.json()).toMatchObject({ rate_limited: true });
    // Another connection still gets through.
    expect((await handle(post(GIFT, '5.6.7.8'), e, fetcher)).status).toBe(200);
  });

  it('limits one campaign across many connections', async () => {
    const fetcher = (async () => new Response('{}')) as unknown as typeof fetch;
    const e = env({ PER_CAMPAIGN: limiter(3) });
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await handle(post(GIFT, `10.0.0.${i}`), e, fetcher)).status);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
    expect((await handle(post({ ...GIFT, campaign: '1012' }, '10.0.0.9'), e, fetcher)).status).toBe(200);
  });

  it('only serves the payment pages, and only by POST', async () => {
    const fetcher = (async () => new Response('{}')) as unknown as typeof fetch;
    expect((await handle(post(GIFT, '1.1.1.1', 'https://evil.example'), env(), fetcher)).status).toBe(403);
    expect((await handle(new Request('https://gate.example/', { method: 'GET', headers: { Origin: 'https://oizer.trubase.org' } }), env(), fetcher)).status).toBe(405);
    const pre = await handle(new Request('https://gate.example/', { method: 'OPTIONS', headers: { Origin: 'https://abc123.oizer-drm.pages.dev' } }), env(), fetcher);
    expect(pre.status).toBe(204);
    expect(pre.headers.get('Access-Control-Allow-Origin')).toBe('https://abc123.oizer-drm.pages.dev');
    expect((await handle(new Request('https://gate.example/', { method: 'POST', headers: { Origin: 'https://oizer.trubase.org' }, body: 'not json' }), env(), fetcher)).status).toBe(400);
    expect((await handle(new Request('https://gate.example/', { method: 'POST', headers: { Origin: 'https://oizer.trubase.org' }, body: 'x'.repeat(40_000) }), env(), fetcher)).status).toBe(413);
  });

  it('counts an IPv6 connection by its /64 network, so rotating addresses in one block does not help', async () => {
    expect(ipKey('1.2.3.4')).toBe('1.2.3.4');
    expect(ipKey('2a09:bac5:b102:4aa::77:24')).toBe('2a09:bac5:b102:4aa::/64');
    expect(ipKey('2a09:bac5:b102:04aa:0:0:77:ae')).toBe('2a09:bac5:b102:4aa::/64');
    expect(ipKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(ipKey(null)).toBe('unknown');
    const fetcher = (async () => new Response('{}')) as unknown as typeof fetch;
    const e = env({ PER_IP: limiter(3) });
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await handle(post(GIFT, `2a09:bac5:b102:4aa::77:${10 + i}`), e, fetcher)).status);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
  });

  it('matches allowed origins exactly or by subdomain', () => {
    const list = 'oizer.trubase.org,*.oizer-drm.pages.dev';
    expect(allowedOrigin('https://oizer.trubase.org', list)).toBe('https://oizer.trubase.org');
    expect(allowedOrigin('https://x.oizer-drm.pages.dev', list)).toBe('https://x.oizer-drm.pages.dev');
    expect(allowedOrigin('https://oizer.trubase.org.evil.example', list)).toBeNull();
    expect(allowedOrigin('https://notoizer-drm.pages.dev', list)).toBeNull();
    expect(allowedOrigin(null, list)).toBeNull();
  });
});

describe('gifts passed on by the payment page’s own site (Moshe Henig, 2026-11-11)', () => {
  const ok = (async () => new Response('{"approved":true}')) as unknown as typeof fetch;
  const viaSite = (secret: string, donorIp: string) => new Request('https://gate.example/', {
    method: 'POST', body: JSON.stringify(GIFT),
    headers: { Origin: 'https://oizer.trubase.org', 'cf-connecting-ip': '172.66.0.1', 'Content-Type': 'application/json', 'x-oizer-gate-proxy': secret, 'x-oizer-client-ip': donorIp },
  });

  it('count each donor by their own address when the site proves itself with the gate secret', async () => {
    const e = env();
    await handle(viaSite('gate-secret', '9.9.9.9'), e, ok);
    expect((e.PER_IP as ReturnType<typeof limiter>).seen).toEqual(['ip:9.9.9.9']);
  });

  it('ignore a claimed donor address without the right secret', async () => {
    const e = env();
    await handle(viaSite('wrong', '9.9.9.9'), e, ok);
    expect((e.PER_IP as ReturnType<typeof limiter>).seen).toEqual(['ip:172.66.0.1']);
  });
});
