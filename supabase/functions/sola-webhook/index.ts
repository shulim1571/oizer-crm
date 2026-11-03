// Sola's transaction webhook, one address per organization: .../sola-webhook?org=<organization id>.
// Deployed with JWT verification off; each post is checked against the organization's PIN instead. Sola
// signs with ck-signature: the field values sorted by lowercased name, joined, plus the PIN, MD5, upper case.

import { crypto } from 'jsr:@std/crypto@1.0.3';
import { encodeHex } from 'jsr:@std/encoding@1.0.5/hex';

const url = Deno.env.get('SUPABASE_URL')!;
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

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

async function signature(form: URLSearchParams, pin: string) {
  const entries = [...form.entries()].map(([k, v]) => [k.toLowerCase(), v] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const text = (entries.map(([, v]) => v).join('') + pin).replace(/[^\x00-\x7F]/g, '?');
  return encodeHex(await crypto.subtle.digest('MD5', new TextEncoder().encode(text))).toUpperCase();
}

Deno.serve(async req => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const org = new URL(req.url).searchParams.get('org');
  if (!org || !/^[0-9a-f-]{36}$/i.test(org)) return new Response('Unknown organization', { status: 400 });
  const form = new URLSearchParams(await req.text());
  let pin: string | null;
  try {
    pin = await rpc('gateway_webhook_pin', { p_org: org });
  } catch {
    return new Response('Unavailable', { status: 503 });
  }
  if (!pin) return new Response('Webhook PIN not set', { status: 401 });
  if ((req.headers.get('ck-signature') ?? '').toUpperCase() !== await signature(form, pin)) return new Response('Bad signature', { status: 401 });
  try {
    await rpc('record_gateway_event', { p_org: org, p_payload: Object.fromEntries(form.entries()) });
  } catch (e) {
    console.error(e);
    return new Response('Not recorded', { status: 500 });
  }
  return new Response('ok');
});
