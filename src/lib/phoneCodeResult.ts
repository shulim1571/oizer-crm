/**
 * What the database's answer to a text or call code means for the person (mfa_phone_verify returns one word).
 * Returns null when the code was right. (Shulim, 2026-11-11: a right code was shown as wrong, because the "no error"
 * value for 'ok' was replaced by the fallback message.)
 */
const MESSAGES: Record<string, string> = {
  wrong: 'That code isn’t right. Check it and try again.',
  expired: 'That code has expired. Send a new one.',
  used: 'That code was already used. Send a new one.',
  locked: 'Too many wrong tries for that code. Send a new one.',
  not_found: 'That code isn’t valid for this sign-in. Send a new one.',
};

export function phoneCodeProblem(result: unknown): string | null {
  if (result === 'ok') return null;
  return MESSAGES[String(result)] ?? 'That code didn’t work. Send a new one.';
}
