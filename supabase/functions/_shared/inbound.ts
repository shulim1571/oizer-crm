// Pieces of the email-inbound function that don't need the network (2026-11-19), so they can be tested on their own.

/** Constant-time comparison of the URL secret against the configured token(s). Empty tokens never match. */
export function tokenMatches(given: string, ...tokens: (string | undefined | null)[]): boolean {
  let ok = false;
  for (const t of tokens) {
    if (!t || !given) continue;
    const a = new TextEncoder().encode(given), b = new TextEncoder().encode(t);
    let diff = a.length ^ b.length;
    for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
    if (diff === 0) ok = true;
  }
  return ok;
}

/** The local parts of the envelope recipients that are at the inbox domain (any case), each once. */
export function inboxRecipients(envelopeJson: string | null, domain: string): string[] {
  let to: unknown = [];
  try { to = JSON.parse(envelopeJson ?? '{}')?.to ?? []; } catch { return []; }
  const d = domain.trim().toLowerCase();
  const out = new Set<string>();
  for (const addr of Array.isArray(to) ? to : [to]) {
    const m = /^\s*<?([^@\s<>]+)@([^@\s<>]+?)>?\s*$/.exec(String(addr));
    if (m && m[2].toLowerCase() === d) out.add(m[1].toLowerCase());
  }
  return [...out];
}

export const envelopeFrom = (envelopeJson: string | null): string | null => {
  try { const f = JSON.parse(envelopeJson ?? '{}')?.from; return f ? String(f).toLowerCase() : null; } catch { return null; }
};

/** The organizational part of a domain: the last two labels (mail.ojcfund.org → ojcfund.org). */
const orgDomain = (d: string) => d.toLowerCase().replace(/\.$/, '').split('.').slice(-2).join('.');
const domainOf = (address: string | null | undefined) => (address && address.includes('@') ? address.split('@').pop()!.toLowerCase() : '');

/** SendGrid's dkim field, e.g. "{@ojcfund.org : pass, @sendgrid.info : pass}", as domain → result pairs. */
export function parseDkim(field: string | null | undefined): { domain: string; result: string }[] {
  const out: { domain: string; result: string }[] = [];
  for (const m of String(field ?? '').matchAll(/@([a-z0-9.-]+)\s*:\s*([a-z]+)/gi)) out.push({ domain: m[1].toLowerCase(), result: m[2].toLowerCase() });
  return out;
}

/**
 * Is the message really from the domain in its From: header? DMARC-style relaxed alignment: DKIM passes for a domain
 * with the same organizational domain as From:, or SPF passes for an envelope sender with the same organizational
 * domain. (Forwarding usually breaks SPF but keeps the sender's DKIM signature, so DKIM is the main check.)
 */
export function authenticity(fromAddress: string | null | undefined, dkimField: string | null | undefined, spf: string | null | undefined,
                             envFrom: string | null | undefined): { authentic: boolean; reason: string } {
  const from = domainOf(fromAddress);
  if (!from) return { authentic: false, reason: 'No From address' };
  const dkim = parseDkim(dkimField).find(d => d.result === 'pass' && orgDomain(d.domain) === orgDomain(from));
  if (dkim) return { authentic: true, reason: `DKIM pass for ${dkim.domain}, aligned with ${from}` };
  const envDomain = domainOf(envFrom);
  if (String(spf ?? '').trim().toLowerCase() === 'pass' && envDomain && orgDomain(envDomain) === orgDomain(from)) {
    return { authentic: true, reason: `SPF pass for ${envDomain}, aligned with ${from}` };
  }
  const seen = parseDkim(dkimField).map(d => `${d.domain} ${d.result}`).join(', ') || 'none';
  return { authentic: false, reason: `No DKIM or SPF pass aligned with ${from} (DKIM: ${seen}; SPF: ${spf || 'none'} for ${envDomain || 'unknown'})` };
}

/** Card-like numbers (13–19 digits passing the Luhn check, spaces or dashes allowed) masked to their last 4. */
export function maskCards(text: string): string {
  return text.replace(/\b(?:\d[ -]?){12,18}\d\b/g, m => {
    const digits = m.replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19) return m;
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      let n = Number(digits[digits.length - 1 - i]);
      if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9; }
      sum += n;
    }
    return sum % 10 === 0 ? `•••• ${digits.slice(-4)}` : m;
  });
}

/** Plain text from an HTML body, for messages without a text part. */
export const htmlToText = (html: string) =>
  html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*/g, '\n\n').trim();

/** A file name safe for a storage path. */
export const safeName = (name: string | null | undefined, i: number) =>
  `${i}-${String(name || 'attachment').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/\.{2,}/g, '').replace(/^\.+/, '').slice(0, 120) || 'attachment'}`;

/** Gmail's forwarding set-up message: shown to the admin whoever sent it, so they can copy the code. */
export const isForwardingConfirmation = (from: string | null | undefined, subject: string | null | undefined) =>
  String(from ?? '').toLowerCase() === 'forwarding-noreply@google.com' && /forwarding confirmation/i.test(String(subject ?? ''));
