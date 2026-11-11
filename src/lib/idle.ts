/**
 * Session limits (Shulim, 2026-11-11): Supabase signs a session out after 30 minutes without activity and after 12
 * hours in all, checked when the session refreshes. The app also signs out after 30 idle minutes on its own, so an
 * idle screen doesn't stay open until the next refresh. Activity in any tab counts (shared through localStorage).
 */
export const IDLE_LIMIT_MS = 30 * 60 * 1000;
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

/** Watches for activity and calls onIdle once 30 minutes pass without any. Returns a function that stops watching. */
export function watchIdle(onIdle: () => void, limit = IDLE_LIMIT_MS): () => void {
  if (idleTooLong(readLastActivity(), Date.now(), limit)) { onIdle(); return () => {}; }
  markActivity();
  let lastWrite = 0;
  const seen = () => { const now = Date.now(); if (now - lastWrite > 15_000) { lastWrite = now; markActivity(now); } };
  const events = ['pointerdown', 'keydown', 'scroll', 'touchstart', 'mousemove'] as const;
  events.forEach(e => window.addEventListener(e, seen, { passive: true }));
  const timer = window.setInterval(() => { if (idleTooLong(readLastActivity(), Date.now(), limit)) onIdle(); }, 30_000);
  return () => { events.forEach(e => window.removeEventListener(e, seen)); window.clearInterval(timer); };
}
