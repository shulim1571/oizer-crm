// What the providers report back. Deployed with JWT verification off; each request is checked instead:
//   ?provider=sendgrid  SendGrid's Event Webhook, signed. SENDGRID_WEBHOOK_PUBLIC_KEY is its verification key.
//   ?provider=twilio    Twilio delivery reports and texts to the organization's number, signed with TWILIO_AUTH_TOKEN.
// With &org=<id> and that organization's own keys on file, the request is checked with its keys instead and
// can only touch that organization's messages. Without its own keys the platform's are used, as before.

const url = Deno.env.get('SUPABASE_URL')!;
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const platformSendgridKey = Deno.env.get('SENDGRID_WEBHOOK_PUBLIC_KEY') ?? null;
const platformTwilioToken = Deno.env.get('TWILIO_AUTH_TOKEN') ?? null;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function rpc(name: string, args: unknown) {
  const res = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`${name}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

const fromBase64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const toBase64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b)));

// SendGrid signs with ECDSA P-256 and sends the signature DER-encoded; WebCrypto wants r and s side by side.
function derToRaw(der: Uint8Array) {
  let i = 2;
  const part = () => {
    if (der[i++] !== 0x02) throw new Error('bad signature');
    const len = der[i++];
    let v = der.slice(i, i + len);
    i += len;
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  };
  const r = part(), s = part();
  const raw = new Uint8Array(64);
  raw.set(r);
  raw.set(s, 32);
  return raw;
}

async function sendgridSigned(req: Request, payload: string, sendgridPublicKey: string | null) {
  const signature = req.headers.get('x-twilio-email-event-webhook-signature');
  const timestamp = req.headers.get('x-twilio-email-event-webhook-timestamp');
  if (!sendgridPublicKey || !signature || !timestamp) return false;
  try {
    const key = await crypto.subtle.importKey('spki', fromBase64(sendgridPublicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToRaw(fromBase64(signature)),
      new TextEncoder().encode(timestamp + payload));
  } catch {
    return false;
  }
}

// Twilio signs the public URL followed by every form field, sorted by name, with HMAC-SHA1.
async function twilioSigned(req: Request, publicUrl: string, form: URLSearchParams, twilioToken: string | null) {
  const signature = req.headers.get('x-twilio-signature');
  if (!twilioToken || !signature) return false;
  const data = publicUrl + [...form.keys()].sort().map(k => k + form.get(k)).join('');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(twilioToken), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const expected = toBase64(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
  return expected === signature;
}

const xml = (t: string) => t.replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]!));
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

Deno.serve(async req => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const params = new URL(req.url).searchParams;
  const provider = params.get('provider');
  const orgParam = params.get('org');
  if (orgParam && !UUID.test(orgParam)) return new Response('Unknown organization', { status: 400 });
  const [own] = orgParam
    ? await rpc('org_messaging_keys', { p_org: orgParam }) as { sendgrid_webhook_key: string | null; twilio_token: string | null }[]
    : [];

  if (provider === 'sendgrid') {
    const payload = await req.text();
    const scope = own?.sendgrid_webhook_key ? orgParam : null;
    if (!await sendgridSigned(req, payload, scope ? own.sendgrid_webhook_key : platformSendgridKey)) return new Response('Bad signature', { status: 401 });
    const events = JSON.parse(payload) as Record<string, string | number>[];
    for (const e of events) {
      await rpc(scope ? 'message_event_scoped' : 'message_event', {
        ...(scope ? { p_scope: scope } : { p_org: e.org_id ?? null }),
        p_id: e.message_id ?? null,
        p_provider_id: e.sg_message_id ?? null,
        p_event: e.event,
        p_reason: e.reason ?? e.response ?? null,
        p_at: e.timestamp ? new Date(Number(e.timestamp) * 1000).toISOString() : null,
      });
    }
    return new Response('ok');
  }

  if (provider === 'twilio') {
    const form = new URLSearchParams(await req.text());
    // Twilio signs the address it called, which is the public one, not the one this function sees.
    const scope = own?.twilio_token ? orgParam : null;
    const publicUrl = `${url}/functions/v1/message-events?provider=twilio${orgParam ? `&org=${orgParam}` : ''}`;
    if (!await twilioSigned(req, publicUrl, form, scope ? own.twilio_token : platformTwilioToken)) return new Response('Bad signature', { status: 401 });
    const status = form.get('MessageStatus');
    if (status) {
      const code = form.get('ErrorCode');
      await rpc(scope ? 'message_event_scoped' : 'message_event', {
        ...(scope ? { p_scope: scope } : { p_org: null }), p_id: null, p_provider_id: form.get('MessageSid'), p_event: status,
        p_reason: code ? `Twilio error ${code}${code === '30003' ? ': the phone is off or unreachable' : code === '30005' ? ': unknown number' : code === '30006' ? ': a landline or unreachable carrier' : code === '30007' ? ': filtered by the carrier' : ''}` : null,
        p_at: null,
      });
      return new Response('ok');
    }
    // A text to the organization's number. Twilio answers STOP and START itself; we record the choice.
    const text = { p_to: form.get('To'), p_from: form.get('From'), p_body: form.get('Body') };
    await rpc(scope ? 'sms_inbound_scoped' : 'sms_inbound', { ...(scope ? { p_scope: scope } : {}), ...text });
    // Campaign lookup (Phase 10): a reply only when the organization turned replies on and the text asks for one.
    const reply = await rpc(scope ? 'sms_lookup_reply_scoped' : 'sms_lookup_reply', { ...(scope ? { p_scope: scope } : {}), ...text })
      .catch(() => null) as string | null;
    return new Response(reply ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${xml(reply)}</Message></Response>` : EMPTY_TWIML,
      { headers: { 'Content-Type': 'text/xml' } });
  }

  return new Response('Unknown provider', { status: 400 });
});
