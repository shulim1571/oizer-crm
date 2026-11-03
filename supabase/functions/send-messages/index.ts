// Sends queued emails through SendGrid and texts through Twilio. The database calls this right after
// queueing and once a minute, with a token only it knows. Deployed with JWT verification off.
// Keys are Edge Function secrets: SENDGRID_API_KEY, TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.

const url = Deno.env.get('SUPABASE_URL')!;
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const sendgridKey = Deno.env.get('SENDGRID_API_KEY');
const twilioSid = Deno.env.get('TWILIO_ACCOUNT_SID');
const twilioToken = Deno.env.get('TWILIO_AUTH_TOKEN');

interface Message {
  org_id: string; id: string; channel: 'email' | 'sms'; to_address: string; to_name: string | null;
  subject: string | null; body: string; html: string | null; kind: string;
  from_name: string; from_email: string; reply_to: string | null; sms_from: string | null;
}
interface Result { ok: boolean; providerId?: string; error?: string; optedOut?: boolean }

async function rpc(name: string, args: unknown): Promise<unknown> {
  const res = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`${name}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function sendEmail(m: Message): Promise<Result> {
  if (!sendgridKey) return { ok: false, error: 'Email isn\'t set up: the SendGrid key is missing' };
  // Opens and clicks are tracked for outreach only; other messages go out as written.
  const track = m.kind === 'outreach';
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${sendgridKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{
        to: [{ email: m.to_address, ...(m.to_name ? { name: m.to_name } : {}) }],
        custom_args: { message_id: m.id, org_id: m.org_id },
      }],
      from: { email: m.from_email, name: m.from_name },
      ...(m.reply_to ? { reply_to: { email: m.reply_to } } : {}),
      subject: m.subject ?? m.from_name,
      content: [{ type: 'text/plain', value: m.body }, ...(m.html ? [{ type: 'text/html', value: m.html }] : [])],
      tracking_settings: { click_tracking: { enable: track, enable_text: false }, open_tracking: { enable: track } },
    }),
  });
  if (res.ok) return { ok: true, providerId: res.headers.get('x-message-id') ?? undefined };
  const body = await res.json().catch(() => ({}));
  return { ok: false, error: body?.errors?.map((e: { message: string }) => e.message).join('; ') || `SendGrid answered ${res.status}` };
}

async function sendSms(m: Message): Promise<Result> {
  if (!twilioSid || !twilioToken) return { ok: false, error: 'Texting isn\'t set up: the Twilio keys are missing' };
  if (!m.sms_from) return { ok: false, error: 'No texting number is set in Messaging Settings' };
  const form = new URLSearchParams({
    To: m.to_address,
    From: m.sms_from,
    Body: m.body,
    StatusCallback: `${url}/functions/v1/message-events?provider=twilio`,
  });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${btoa(`${twilioSid}:${twilioToken}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  const body = await res.json().catch(() => ({}));
  if (res.ok) return { ok: true, providerId: body.sid };
  // 21610: the person replied STOP to this number.
  return { ok: false, optedOut: body.code === 21610, error: body.message ? `${body.message}${body.code ? ` (Twilio ${body.code})` : ''}` : `Twilio answered ${res.status}` };
}

async function send(m: Message) {
  let r: Result;
  try {
    r = m.channel === 'sms' ? await sendSms(m) : await sendEmail(m);
  } catch (e) {
    r = { ok: false, error: `Couldn't reach the provider: ${e instanceof Error ? e.message : e}` };
  }
  await rpc('message_sent', { p_org: m.org_id, p_id: m.id, p_ok: r.ok, p_provider_id: r.providerId ?? null, p_error: r.error ?? null, p_opted_out: !!r.optedOut });
  return r.ok;
}

Deno.serve(async req => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const token = req.headers.get('x-cron-token') ?? '';
  if (!token || await rpc('check_cron_token', { p_token: token }) !== true) return new Response('Forbidden', { status: 403 });

  await rpc('messaging_ready', { p_email: !!sendgridKey, p_sms: !!(twilioSid && twilioToken) });
  let sent = 0, failed = 0;
  // Several rounds, so a large outreach send doesn't wait for the next minute.
  for (let round = 0; round < 10; round++) {
    const batch = await rpc('claim_messages', { p_limit: 25 }) as Message[];
    if (!batch.length) break;
    const results = await Promise.all(batch.map(send));
    sent += results.filter(Boolean).length;
    failed += results.filter(r => !r).length;
  }
  return Response.json({ sent, failed });
});
