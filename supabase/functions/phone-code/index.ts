// Sends two-step verification codes by text or voice call from Oizer's Twilio number (Shulim, 2026-11-11).
// The signed-in person's request is checked by the database as them first (mfa_phone_start: limits, phone, this
// session); then, with the service role, the database makes the code and keeps only its hash (mfa_phone_issue),
// and this function sends it with the Twilio credentials in Supabase secrets. The code is never returned to the
// browser or logged. Checking the code is done by the database directly (mfa_phone_verify).

import { callTwiml, MFA_FROM, smsBody } from '../_shared/phoneCode.ts';

const url = Deno.env.get('SUPABASE_URL')!;
const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const twilioSid = Deno.env.get('TWILIO_ACCOUNT_SID') ?? null;
const twilioToken = Deno.env.get('TWILIO_AUTH_TOKEN') ?? null;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-org-id',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: CORS });

async function rpc(name: string, args: unknown, token: string | null) {
  const res = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: token ? anonKey : serviceKey, Authorization: `Bearer ${token ?? serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.message ?? `${name} failed (${res.status})`);
  return body;
}

async function twilio(path: 'Messages' | 'Calls', form: Record<string, string>) {
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/${path}.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${btoa(`${twilioSid}:${twilioToken}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
  });
  if (res.ok) return null;
  const b = await res.json().catch(() => ({}));
  return b.code === 21610 ? 'This phone has opted out of texts from Donor Base. Choose a call instead, or text START to the number.'
    : `The code couldn't be sent${b.message ? `: ${b.message}` : ''}.`;
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return reply({ error: 'Method not allowed' }, 405);
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return reply({ error: 'Sign in first.' }, 401);
  if (!twilioSid || !twilioToken) return reply({ error: 'Text and call codes aren\'t set up yet.' });
  const b = await req.json().catch(() => ({})) as Record<string, unknown>;
  const purpose = b.purpose === 'enroll' ? 'enroll' : 'signin';
  const channel = b.channel === 'call' ? 'call' : 'sms';

  // As the person: their limits, their phone, this session.
  let challenge: { challenge_id: string; phone_masked: string };
  try {
    [challenge] = await rpc('mfa_phone_start', { p_purpose: purpose, p_channel: channel, p_phone: typeof b.phone === 'string' ? b.phone : null }, token);
  } catch (e) {
    return reply({ error: e instanceof Error ? e.message : String(e) });
  }
  // The database makes the code and keeps only its hash; it comes back here once, for sending.
  const [issued] = await rpc('mfa_phone_issue', { p_challenge: challenge.challenge_id }, null) as { phone: string; channel: string; code: string }[];
  if (!issued) return reply({ error: 'The code couldn\'t be made. Try again.' });

  const problem = issued.channel === 'call'
    ? await twilio('Calls', { From: MFA_FROM, To: issued.phone, Twiml: callTwiml(issued.code) })
    : await twilio('Messages', { From: MFA_FROM, To: issued.phone, Body: smsBody(issued.code) });
  if (problem) return reply({ error: problem });
  return reply({ challenge_id: challenge.challenge_id, phone_masked: challenge.phone_masked, channel: issued.channel });
});
