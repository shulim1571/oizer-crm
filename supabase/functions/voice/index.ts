// The phone line (Phase 10): a campaign's numbers by keypad, at the organization's number. Twilio calls this
// for each step of the call; every request is checked against Twilio's signature. JWT verification is off.
//
//   Call in        -> "Enter the campaign number, then pound. Fundraisers, press star for your campaigns."
//   step=campaign  -> a registered fundraiser's campaign is read out; anyone else is asked for the PIN
//   step=pin       -> the PIN is checked (three tries, five wrong PINs an hour lock the phone)
//   step=menu      -> after a campaign's numbers, a known caller (donor, fundraiser or admin on file) of a campaign
//                     with teams may press 1 to hear its teams or 2 for another campaign (Moshe Henig, 2026-11-11)
//   step=team      -> the teams are read as a numbered list; the caller presses a team's number, then pound
//
// While the organization's phone line is off, calls are rejected, which Twilio doesn't bill. Card payments by
// phone are not here: they wait for the decision on Twilio <Pay> (see docs/PLATFORM_ROADMAP.md, Phase 10).
// With &org=<id> and that organization's own Twilio keys, its auth token checks the signature instead.

const url = Deno.env.get('SUPABASE_URL')!;
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const platformTwilioToken = Deno.env.get('TWILIO_AUTH_TOKEN') ?? null;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function rpc(name: string, args: unknown) {
  const res = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`${name}: ${res.status}`);
  return res.json();
}

const toBase64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b)));
async function twilioSigned(req: Request, publicUrl: string, form: URLSearchParams, token: string | null) {
  const signature = req.headers.get('x-twilio-signature');
  if (!token || !signature) return false;
  const data = publicUrl + [...form.keys()].sort().map(k => k + form.get(k)).join('');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(token), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  return toBase64(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))) === signature;
}

const esc = (t: string) => t.replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]!));
const twiml = (body: string) => new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, { headers: { 'Content-Type': 'text/xml' } });
const say = (t: string) => `<Say>${esc(t)}</Say>`;
const money = (n: number) => `${n < 0 ? 'minus ' : ''}$${Math.abs(n).toFixed(2)}`;
// Read digits one by one so "1001" isn't "one thousand and one".
const spell = (id: string) => id.split('').join(' ');

interface Campaign { id: string; name: string; raised: number; expenses: number; balance: number; pending: number }
const summary = (c: Campaign) =>
  `Campaign ${spell(c.id)}, ${c.name}. Raised ${money(c.raised)}. Expenses ${money(c.expenses)}. Balance ${money(c.balance)}.` +
  (c.pending ? ` Pending ${money(c.pending)}.` : '');

Deno.serve(async req => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const u = new URL(req.url);
  const orgParam = u.searchParams.get('org');
  if (orgParam && !UUID.test(orgParam)) return new Response('Unknown organization', { status: 400 });
  const form = new URLSearchParams(await req.text());
  const [own] = orgParam ? await rpc('org_messaging_keys', { p_org: orgParam }) as { twilio_token: string | null }[] : [];
  const publicUrl = `${url}/functions/v1/voice${u.search}`;
  if (!await twilioSigned(req, publicUrl, form, own?.twilio_token ?? platformTwilioToken)) return new Response('Bad signature', { status: 401 });

  const [org] = await rpc('phone_org', { p_to: form.get('To') }) as { org_id: string; org_name: string; voice: boolean }[];
  if (!org?.voice) return twiml('<Reject/>');
  const from = form.get('From') ?? '';
  const digits = (form.get('Digits') ?? '').trim();
  const step = u.searchParams.get('step');
  const keep = orgParam ? `&amp;org=${orgParam}` : '';
  const askCampaign = (lead = '') =>
    `<Gather input="dtmf" finishOnKey="#" timeout="8" action="voice?step=campaign${keep}">` +
    say(`${lead}Enter the campaign number, then press pound. Fundraisers calling from a registered phone, press star, then pound, for your campaigns.`) +
    `</Gather>${say('We didn’t get a number. Goodbye.')}<Hangup/>`;
  const askPin = (campaign: string, tries: number, lead = '') =>
    `<Gather input="dtmf" finishOnKey="#" timeout="8" action="voice?step=pin&amp;c=${encodeURIComponent(campaign)}&amp;n=${tries}${keep}">` +
    say(`${lead}Enter the PIN for campaign ${spell(campaign)}, then press pound.`) + `</Gather>${say('Goodbye.')}<Hangup/>`;

  const call = form.get('CallSid') ?? '';
  type Team = { n: number; id: string; name: string; raised: number };
  const teamsOf = async (campaign: string) =>
    (call ? await rpc('phone_teams', { p_org: org.org_id, p_from: from, p_call: call, p_campaign: campaign }) : []) as Team[];
  // After a campaign's numbers: known callers of a campaign with teams get the Teams option; everyone else, as before.
  const reached = async (c: Campaign) => {
    if (call) await rpc('phone_call_reached', { p_org: org.org_id, p_call: call, p_campaign: c.id });
    const teams = await teamsOf(c.id);
    if (!teams.length) return twiml(say(summary(c)) + askCampaign('For another campaign, '));
    return twiml(say(summary(c)) + menu(c.id));
  };
  const menu = (campaign: string, again = false) =>
    `<Gather input="dtmf" numDigits="1" timeout="8" action="voice?step=menu&amp;c=${encodeURIComponent(campaign)}${keep}">` +
    say(`To hear ${again ? 'the teams again' : "this campaign's teams"}, press 1. For another campaign, press 2.`) + `</Gather>` + askCampaign();
  const askTeam = (campaign: string, teams: Team[], lead = '') =>
    `<Gather input="dtmf" finishOnKey="#" timeout="10" action="voice?step=team&amp;c=${encodeURIComponent(campaign)}${keep}">` +
    say(`${lead}${teams.map(t => `For ${t.name}, press ${t.n}.`).join(' ')} Then press pound.`) + `</Gather>` + askCampaign();

  const answer = async (campaign: string | null, pin: string | null) =>
    await rpc('phone_lookup', { p_org: org.org_id, p_channel: 'voice', p_from: from, p_campaign: campaign, p_pin: pin }) as
      { outcome: string; campaign?: Campaign; campaigns?: Campaign[]; campaign_id?: string };

  if (!step) return twiml(askCampaign(`Welcome to ${org.org_name}. `));

  if (step === 'campaign') {
    if (digits === '*' || digits === '') {
      const r = await answer(null, null);
      if (r.outcome === 'list') {
        const list = r.campaigns ?? [];
        return twiml(askCampaign(list.length
          ? `${list.map(c => `Campaign ${spell(c.id)}, ${c.name}, balance ${money(c.balance)}.`).join(' ')} For details, `
          : 'This phone has no active campaigns. '));
      }
      return twiml(askCampaign('This phone isn’t registered to a fundraiser. '));
    }
    if (!/^\d{1,10}$/.test(digits)) return twiml(askCampaign('That isn’t a campaign number. '));
    const r = await answer(digits, null);
    if (r.outcome === 'answered') return reached(r.campaign!);
    if (r.outcome === 'needs_pin') return twiml(askPin(digits, 1));
    if (r.outcome === 'locked') return twiml(say('Too many wrong PINs from this phone. Please try again in an hour. Goodbye.') + '<Hangup/>');
    return twiml(askCampaign('There’s no campaign with that number. '));
  }

  if (step === 'pin') {
    const campaign = u.searchParams.get('c') ?? '';
    const tries = Number(u.searchParams.get('n') ?? '1');
    const r = await answer(campaign, digits);
    if (r.outcome === 'answered') return reached(r.campaign!);
    if (r.outcome === 'locked') return twiml(say('Too many wrong PINs from this phone. Please try again in an hour. Goodbye.') + '<Hangup/>');
    if (r.outcome === 'wrong_pin' && tries < 3) return twiml(askPin(campaign, tries + 1, 'That PIN doesn’t match. '));
    return twiml(say('That PIN doesn’t match. Goodbye.') + '<Hangup/>');
  }

  // The Teams option and the team list: only for a known caller on a call that reached this campaign (checked by
  // the database), so no one is asked for a team before pressing Teams, and callers not on file never hear it.
  if (step === 'menu' || step === 'team') {
    const campaign = u.searchParams.get('c') ?? '';
    const teams = await teamsOf(campaign);
    if (!teams.length) return twiml(askCampaign());
    if (step === 'menu') {
      if (digits === '1') return twiml(askTeam(campaign, teams, `Campaign ${spell(campaign)} has ${teams.length} team${teams.length === 1 ? '' : 's'}. `));
      return twiml(askCampaign());
    }
    const choice = /^\d{1,3}$/.test(digits) ? Number(digits) : NaN;
    const t = Number.isFinite(choice)
      ? await rpc('phone_pick_team', { p_org: org.org_id, p_from: from, p_call: call, p_campaign: campaign, p_choice: choice }) as Team | null
      : null;
    if (!t) return twiml(askTeam(campaign, teams, 'That isn’t one of the team numbers. '));
    return twiml(say(`Team ${spell(t.id)}, ${t.name}. Raised ${money(Number(t.raised))}.`) + menu(campaign, true));
  }

  return twiml(askCampaign());
});
