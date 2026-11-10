// Guards for the public give function, kept free of Deno APIs so they can be tested.

/**
 * Whether a payment-page request may go on to Sola, as far as the bot check goes. There is no exception for
 * sandbox keys any more: with no Turnstile secret (the organization's or the platform's) the page can't take
 * payments, so a missing setup is caught before go-live instead of quietly skipped.
 */
export type BotDecision = 'verify' | 'not_set_up' | 'no_token';
export function botCheckDecision(secret: string | null | undefined, token: string | null | undefined): BotDecision {
  if (!secret) return 'not_set_up';
  if (!token) return 'no_token';
  return 'verify';
}

/** Compares the gate's shared secret without leaking how much of it matched. */
export function sameSecret(expected: string, got: string | null | undefined): boolean {
  if (!got) return false;
  const a = new TextEncoder().encode(expected);
  const b = new TextEncoder().encode(got);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/**
 * Whether the request came through the rate-limiting gate (workers/give-gate), and the donor's IP it reports.
 * With no gate secret configured every request is let through, as before the gate existed; once it's set,
 * only the gate can call the give function.
 */
export function gateCheck(gateSecret: string | null | undefined, headers: { get(name: string): string | null }):
  { ok: true; ip: string | null } | { ok: false } {
  const direct = (headers.get('cf-connecting-ip') ?? headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || null;
  if (!gateSecret) return { ok: true, ip: direct };
  if (!sameSecret(gateSecret, headers.get('x-give-gate'))) return { ok: false };
  return { ok: true, ip: (headers.get('x-oizer-client-ip') ?? '').trim() || direct };
}

/** The donor details every payment needs (Moshe Henig, 2026-11-10: the ZIP or postal code is required). */
export function donorProblem(d: Record<string, unknown> | null | undefined): string | null {
  const has = (k: string) => typeof d?.[k] === 'string' && (d[k] as string).trim() !== '';
  if (!has('zip')) return 'Enter your ZIP or postal code.';
  return null;
}
