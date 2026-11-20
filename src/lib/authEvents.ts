/**
 * Which Supabase auth events change who is signed in (Moshe Henig, 2026-11-12: "the page reloads every time I come
 * back to the tab"). Supabase announces SIGNED_IN again whenever a tab becomes visible, and TOKEN_REFRESHED whenever
 * it renews the token, for the same person. Treating those as a new sign-in reloaded access and two-step
 * verification on every return to the tab; while the token was still being renewed those checks could fail and
 * swap the app for a sign-in or error screen and back, which reset the page. For the same person they now change
 * nothing; the Supabase client keeps the renewed token itself.
 */
export function isRepeatAuthEvent(event: string, previousUserId: string | null, nextUserId: string | null): boolean {
  if (!previousUserId || previousUserId !== nextUserId) return false;   // signed in, out, or as someone else
  return event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'INITIAL_SESSION';
}

/** Events after which two-step verification may have changed for the same person. */
export const MFA_EVENTS = new Set(['SIGNED_IN', 'SIGNED_OUT', 'MFA_CHALLENGE_VERIFIED', 'USER_UPDATED', 'INITIAL_SESSION']);
