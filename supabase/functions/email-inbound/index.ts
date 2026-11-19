// Organization inboxes (Shulim, 2026-11-19; docs/review/org-inbox-plan-2026-11-19.md).
//
//   POST /functions/v1/email-inbound/<INBOUND_PARSE_TOKEN>   SendGrid Inbound Parse ("POST the raw, full MIME message" on)
//   POST /functions/v1/email-inbound/retention               the daily clean-up (x-cron-token), removing expired raw files
//
// Deployed with JWT verification off: SendGrid can't sign in. The secret at the end of the URL is the check; anything
// else gets 404. Each message is stored under the organization its address belongs to (raw .eml and attachments in
// the private "inbox" bucket), then the database decides trusted (to review) or not trusted. Nothing posts.
// Settings: INBOUND_PARSE_TOKEN (and INBOUND_PARSE_TOKEN_NEXT while changing it) are Edge Function secrets; the inbox
// domain is the platform setting inbox_domain. None of them is in the code.
import PostalMime from 'npm:postal-mime@4.1.4';
import { apiHeaders } from '../_shared/keys.ts';
import { authenticity, envelopeFrom, htmlToText, inboxRecipients, isForwardingConfirmation, maskCards, safeName, tokenMatches } from '../_shared/inbound.ts';

const url = Deno.env.get('SUPABASE_URL')!;
const notFound = () => new Response(null, { status: 404 });

async function rpc<T = unknown>(name: string, args: unknown): Promise<T> {
  const res = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: 'POST', headers: { ...apiHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(args),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${name}: ${res.status} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : null) as T;
}

async function upload(path: string, body: Uint8Array<ArrayBuffer> | string, mime: string) {
  const res = await fetch(`${url}/storage/v1/object/inbox/${path.split('/').map(encodeURIComponent).join('/')}`, {
    method: 'POST', headers: { ...apiHeaders(), 'Content-Type': mime || 'application/octet-stream', 'x-upsert': 'true' }, body,
  });
  if (!res.ok) throw new Error(`storage: ${res.status} ${(await res.text()).slice(0, 200)}`);
}

const sha256 = async (bytes: Uint8Array<ArrayBuffer>) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');

/** An attachment's bytes, as a plain (ArrayBuffer-backed) copy whatever the parser handed back. */
const bytesOf = (c: unknown): Uint8Array<ArrayBuffer> =>
  c instanceof Uint8Array ? new Uint8Array(c) : c instanceof ArrayBuffer ? new Uint8Array(c.slice(0)) : new TextEncoder().encode(String(c ?? ''));

async function receive(req: Request): Promise<Response> {
  const domain = await rpc<string | null>('inbox_domain', {});
  if (!domain) return new Response('Inbox domain not set', { status: 503 });
  const form = await req.formData();
  const field = (k: string) => { const v = form.get(k); return typeof v === 'string' ? v : null; };
  const raw = field('email');
  if (!raw) return Response.json({ ok: true, stored: 0, note: 'not a raw Inbound Parse post' });
  const envelope = field('envelope');
  const locals = inboxRecipients(envelope, domain);
  if (!locals.length) return Response.json({ ok: true, stored: 0 });

  const mail = await PostalMime.parse(raw);
  const fromAddress = mail.from?.address?.toLowerCase() ?? null;
  const envFrom = envelopeFrom(envelope);
  const auth = authenticity(fromAddress, field('dkim'), field('SPF'), envFrom);
  const confirm = isForwardingConfirmation(fromAddress, mail.subject);
  const text = maskCards(mail.text?.trim() ? mail.text : htmlToText(mail.html ?? ''));
  const meta = {
    message_id: mail.messageId ?? null, from_address: fromAddress, from_name: mail.from?.name ?? null, subject: mail.subject ? maskCards(mail.subject) : null,
    sent_at: mail.date ? new Date(mail.date).toISOString() : null, envelope_from: envFrom, size_bytes: raw.length,
    spam_score: field('spam_score') ? Number(field('spam_score')) : null, spf: field('SPF'), dkim: field('dkim'),
  };

  let stored = 0;
  for (const local of locals) {
    const [r] = await rpc<{ org_id: string | null; email_id: string | null; outcome: string }[]>('inbox_receive', { p_local: local, p_meta: meta });
    if (!r?.email_id || !r.org_id) { console.log(`inbox: ${r?.outcome ?? 'no result'}`); continue; }   // unknown/off address, or over the daily cap
    const dir = `${r.org_id}/${r.email_id}`;
    await upload(`${dir}/message.eml`, raw, 'message/rfc822');
    const files = [];
    for (const [i, a] of (mail.attachments ?? []).entries()) {
      const bytes = bytesOf(a.content);
      const path = `${dir}/${safeName(a.filename, i + 1)}`;
      await upload(path, bytes, a.mimeType);
      files.push({ filename: a.filename ?? null, mime: a.mimeType ?? null, size_bytes: bytes.length, sha256: await sha256(bytes), storage_path: path });
    }
    await rpc('inbox_finish', {
      p_org: r.org_id, p_email: r.email_id, p_raw_path: `${dir}/message.eml`, p_body_text: text, p_authentic: auth.authentic,
      p_auth_reason: auth.reason, p_attachments: files, p_forwarding_confirmation: confirm,
    });
    stored++;
  }
  return Response.json({ ok: true, stored });
}

async function retention(req: Request): Promise<Response> {
  if (await rpc<boolean>('check_cron_token', { p_token: req.headers.get('x-cron-token') ?? '' }) !== true) return notFound();
  let removed = 0;
  for (let round = 0; round < 10; round++) {
    const rows = await rpc<{ org_id: string; email_id: string; path: string }[]>('inbox_expired_files', { p_limit: 200 });
    if (!rows.length) break;
    const res = await fetch(`${url}/storage/v1/object/inbox`, {
      method: 'DELETE', headers: { ...apiHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: rows.map(r => r.path) }),
    });
    if (!res.ok) throw new Error(`storage delete: ${res.status}`);
    for (const key of new Set(rows.map(r => `${r.org_id}|${r.email_id}`))) {
      const [org, email] = key.split('|');
      await rpc('inbox_files_removed', { p_org: org, p_email: email });
    }
    removed += rows.length;
  }
  return Response.json({ ok: true, removed });
}

Deno.serve(async req => {
  if (req.method !== 'POST') return notFound();
  const last = new URL(req.url).pathname.split('/').filter(Boolean).pop() ?? '';
  try {
    if (last === 'retention') return await retention(req);
    if (!tokenMatches(last, Deno.env.get('INBOUND_PARSE_TOKEN'), Deno.env.get('INBOUND_PARSE_TOKEN_NEXT'))) {
      console.log('inbox: token bad');
      return notFound();
    }
    return await receive(req);
  } catch (e) {
    // 500 makes SendGrid retry (for up to 3 days); a half-stored message is picked up again by its Message-ID.
    console.error('inbox: failed', e instanceof Error ? e.message : String(e));
    return new Response('Try again', { status: 500 });
  }
});
