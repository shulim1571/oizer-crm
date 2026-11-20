/**
 * Asking the database who someone is (my_access), without mistaking a failed request for "no access".
 * Shulim's super admin login landed on "Waiting for access: this login isn't part of Oizer" (2026-11-11): the
 * database had him as Super Admin, but the access request itself failed (an expired or revoked session still
 * shows the email in the browser), and the app read the empty answer as "not a member". Now a failed request is
 * retried once with a refreshed session; if the session can't be refreshed it's reported as expired (back to
 * sign-in), and any other failure is reported as a failure, never as missing access.
 */
export type AccessResult<T> = { kind: 'ok'; access: T } | { kind: 'expired' } | { kind: 'error'; message: string };

type Rpc<T> = () => PromiseLike<{ data: T | null; error: { message: string; code?: string; status?: number } | null }>;
type Refresh = () => PromiseLike<{ data: { session: unknown | null }; error: unknown | null }>;

const looksExpired = (e: { message: string; code?: string; status?: number }) =>
  e.status === 401 || e.code === 'PGRST301' || e.code === 'PGRST303' || /jwt|token|expired|unauthori[sz]ed/i.test(e.message);

export async function loadAccessSafely<T>(rpc: Rpc<T>, refresh: Refresh): Promise<AccessResult<T>> {
  const first = await rpc();
  if (!first.error && first.data) return { kind: 'ok', access: first.data };
  // Failed, or answered nothing: get a fresh session and ask once more.
  const r = await refresh();
  if (r.error || !r.data.session) return first.error && !looksExpired(first.error) ? { kind: 'error', message: first.error.message } : { kind: 'expired' };
  const second = await rpc();
  if (!second.error && second.data) return { kind: 'ok', access: second.data };
  if (second.error && looksExpired(second.error)) return { kind: 'expired' };
  return { kind: 'error', message: second.error?.message ?? 'No answer about this login\'s access.' };
}

/** Only the newest access check may change what the app shows; an older one finishing late is ignored. */
export function latestOnly() {
  let n = 0;
  return () => { const mine = ++n; return () => mine === n; };
}
