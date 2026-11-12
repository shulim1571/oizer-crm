/**
 * Session limits (Shulim, 2026-11-11): Supabase signs a session out after 30 minutes without activity and after 12
 * hours in all, checked when the session refreshes. The app also signs out after 30 idle minutes on its own, so an
 * idle screen doesn't stay open until the next refresh. Activity in any tab counts (shared through localStorage).
 *
 * Idle timeout, not a fixed one (Moshe Henig, 2026-11-12: "it signs users out every 30 minutes no matter what").
 * The server counts a session as active only when it is renewed, and the browser renewed it only when its 60-minute
 * token ran out, so even someone working the whole time went over 30 minutes between renewals and was signed out.
 * Now, while the person is active, the session is renewed every 10 minutes; they are signed out only after the
 * organization's idle limit (idle_timeout_minutes, 30 by default) passes with no activity. Activity is clicks,
 * typing, scrolling, page changes and the app's own requests, except the ones it makes by itself on a timer.
 */
export const IDLE_LIMIT_MS = 30 * 60 * 1000;
/** The organization's idle limit, in minutes: from 5 to 720 (the 12-hour session limit). */
export const IDLE_MINUTES_DEFAULT = 30;
export function idleLimitMs(minutes: unknown): number {
  const n = Number(minutes);
  return Number.isInteger(n) && n >= 5 && n <= 720 ? n * 60 * 1000 : IDLE_LIMIT_MS;
}
/** A whole number of minutes from 5 to 720, or an error message (for the Organization settings screen). */
export function parseIdleMinutes(text: string): number | string {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return 'Enter a whole number of minutes.';
  const n = Number(t);
  if (n < 5 || n > 720) return 'Enter a number of minutes from 5 to 720 (12 hours).';
  return n;
}
/** How often an active session is renewed, well inside the server's 30-minute limit. */
export const RENEW_EVERY_MS = 10 * 60 * 1000;
const RENEWED_KEY = 'session-renewed';
export const MAX_SESSION_HOURS = 12;
const KEY = 'last-activity';

export const idleTooLong = (last: number | null, now: number, limit = IDLE_LIMIT_MS) => last != null && now - last > limit;

export function readLastActivity(): number | null {
  try { const v = Number(localStorage.getItem(KEY)); return Number.isFinite(v) && v > 0 ? v : null; } catch { return null; }
}

export function markActivity(now = Date.now()) {
  try { localStorage.setItem(KEY, String(now)); } catch { /* private window: the server limit still applies */ }
}

/** Forget the last activity: after an idle sign-out, so the old time can't count against the next sign-in. */
export function clearActivity() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

/**
 * A fresh sign-in starts the idle clock again (Shulim, 2026-11-11: after an idle sign-out, signing in again was
 * signed straight back out because the old activity time was still stored).
 */
export function startFreshSession(now = Date.now()) {
  markActivity(now);
  try { sessionStorage.removeItem('signed-out-idle'); } catch { /* ignore */ }
}

let lastNoted = 0;
/** Something happened that counts as activity (throttled: the stored time moves at most every 15 seconds). */
export function noteActivity(now = Date.now()) {
  if (now - lastNoted < 15_000) return;
  lastNoted = now;
  markActivity(now);
}

/** Requests the app makes by itself on a timer (unread count, inbox polling, domain checks); they aren't activity. */
const BACKGROUND = [/\/auth\/v1\//, /\/rpc\/unread_message_count/, /\/rpc\/my_threads/, /\/rpc\/thread_history/, /\/rest\/v1\/announcements/, /\/functions\/v1\/domains/];
export const countsAsActivity = (url: string) => /\/(rest|functions)\/v1\//.test(url) && !BACKGROUND.some(r => r.test(url));

function readRenewed(): number {
  try { const v = Number(localStorage.getItem(RENEWED_KEY)); return Number.isFinite(v) ? v : 0; } catch { return 0; }
}
function markRenewed(now: number) {
  try { localStorage.setItem(RENEWED_KEY, String(now)); } catch { /* ignore */ }
}

/**
 * Watches for activity and calls onIdle once `limit` passes without any. While the person is still active (inside the
 * limit), calls renew every 10 minutes (shared across tabs), so the server never ends a session that's in use.
 * Returns a function that stops watching.
 */
export function watchIdle(onIdle: () => void, limit = IDLE_LIMIT_MS, renew?: () => PromiseLike<unknown>): () => void {
  if (idleTooLong(readLastActivity(), Date.now(), limit)) { onIdle(); return () => {}; }
  markActivity();
  if (!readRenewed()) markRenewed(Date.now());
  const seen = () => noteActivity();
  const events = ['pointerdown', 'keydown', 'scroll', 'wheel', 'touchstart', 'mousemove'] as const;
  events.forEach(e => window.addEventListener(e, seen, { passive: true }));
  const check = () => {
    const now = Date.now();
    if (idleTooLong(readLastActivity(), now, limit)) return onIdle();
    // Marked before asking, so renewals stay 10 minutes apart (across tabs too) even if one never answers.
    if (renew && now - readRenewed() >= RENEW_EVERY_MS) {
      markRenewed(now);
      Promise.resolve(renew()).catch(() => { /* a failed renewal signs out through Supabase */ });
    }
  };
  const timer = window.setInterval(check, 30_000);
  return () => { events.forEach(e => window.removeEventListener(e, seen)); window.clearInterval(timer); };
}
