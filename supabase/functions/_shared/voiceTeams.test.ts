import { createHmac } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The phone line's Teams option (Moshe Henig, 2026-11-11), run against fake Twilio requests and a fake database.
const TOKEN = 'test-twilio-token';
const BASE = 'https://example.supabase.co';
let handler: (req: Request) => Promise<Response>;
let db: { fail?: boolean; known: boolean; teams: { n: number; id: string; name: string; raised: number }[]; reached: string[] };

function call(params: Record<string, string>, query = '') {
  const form = new URLSearchParams({ To: '+18456134272', From: '+17185550101', CallSid: 'CA123', ...params });
  const publicUrl = `${BASE}/functions/v1/voice${query}`;
  const sig = createHmac('sha1', TOKEN).update(publicUrl + [...form.keys()].sort().map(k => k + form.get(k)).join('')).digest('base64');
  return handler(new Request(`http://localhost/voice${query}`, { method: 'POST', headers: { 'x-twilio-signature': sig }, body: form.toString() }))
    .then(r => r.text());
}

beforeAll(async () => {
  (globalThis as any).Deno = {
    env: { get: (k: string) => ({ SUPABASE_URL: BASE, SUPABASE_SERVICE_ROLE_KEY: 'svc', TWILIO_AUTH_TOKEN: TOKEN } as Record<string, string>)[k] },
    serve: (h: typeof handler) => { handler = h; },
  };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const name = url.split('/rpc/')[1];
    const args = JSON.parse(String(init.body));
    const ok = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
    if (name === 'phone_org') return ok([{ org_id: 'org', org_name: 'Oizer', voice: true }]);
    if (name === 'phone_lookup') return ok(args.p_pin === '4321' || !args.p_pin && db.known
      ? { outcome: 'answered', campaign: { id: '1002', name: 'Oizer second', raised: 100, expenses: 0, balance: 100, pending: 0 } }
      : { outcome: 'needs_pin', campaign_id: '1002' });
    // A function returning nothing answers 204 with an empty body, as PostgREST does (the 2026-11-11 outage).
    if (name === 'phone_call_reached') { db.reached.push(args.p_campaign); return new Response(null, { status: 204 }); }
    // The database gives teams only to a known caller on a call that reached the campaign.
    if (db.fail && name.startsWith('phone_') && name !== 'phone_org' && name !== 'phone_lookup') return new Response('boom', { status: 500 });
    if (name === 'phone_teams') return ok(db.known && db.reached.includes(args.p_campaign) ? db.teams : []);
    if (name === 'phone_pick_team') return ok(db.known && db.reached.includes(args.p_campaign) ? db.teams.find(t => t.n === args.p_choice) ?? null : null);
    throw new Error(`unexpected rpc ${name}`);
  });
  await import('../voice/index.ts');
});
beforeEach(() => { db = { known: true, teams: [{ n: 1, id: '1002A', name: 'Table 1', raised: 50 }, { n: 2, id: '1002C', name: 'Table 2', raised: 0 }], reached: [] }; });

describe('phone line Teams option', () => {
  it('is offered after the campaign is read, to a known caller of a campaign with teams', async () => {
    const xml = await call({ Digits: '1002' }, '?step=campaign');
    expect(xml).toContain('Campaign 1 0 0 2, Oizer second.');
    expect(xml).toContain("To hear this campaign&apos;s teams, press 1. For another campaign, press 2.");
    expect(xml).not.toContain('For Table 1');                       // no team asked for before Teams is pressed
  });

  it('reads the teams as a numbered list when 1 is pressed, and the caller picks one by number', async () => {
    await call({ Digits: '1002' }, '?step=campaign');
    const list = await call({ Digits: '1' }, '?step=menu&c=1002');
    expect(list).toContain('Campaign 1 0 0 2 has 2 teams. For Table 1, press 1. For Table 2, press 2. Then press pound.');
    const picked = await call({ Digits: '2' }, '?step=team&c=1002');
    expect(picked).toContain('Team 1 0 0 2 C, Table 2. Raised $0.00.');
    expect(await call({ Digits: '7' }, '?step=team&c=1002')).toContain('That isn’t one of the team numbers.');
  });

  it('is not offered to a caller whose number is not on file', async () => {
    db.known = false;
    const xml = await call({ Digits: '4321' }, '?step=pin&c=1002&n=1');
    expect(xml).toContain('Oizer second');
    expect(xml).not.toContain('teams');
    expect(await call({ Digits: '1' }, '?step=menu&c=1002')).not.toContain('For Table');
  });

  it('never stops the call: if the Teams part fails, the caller still hears the campaign', async () => {
    db.fail = true;
    const xml = await call({ Digits: '1002' }, '?step=campaign');
    expect(xml).toContain('Campaign 1 0 0 2, Oizer second.');
    expect(xml).toContain('For another campaign, Enter the campaign number');
    expect(await call({ Digits: '1' }, '?step=menu&c=1002')).toContain('Enter the campaign number');
  });

  it('asks a caller without a registered phone for the PIN, as before', async () => {
    db.known = false;
    expect(await call({ Digits: '1002' }, '?step=campaign')).toContain('Enter the PIN for campaign 1 0 0 2');
  });

  it('is not offered for a campaign without teams', async () => {
    db.teams = [];
    expect(await call({ Digits: '1002' }, '?step=campaign')).not.toContain('teams');
  });
});
