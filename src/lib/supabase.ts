import { createClient } from '@supabase/supabase-js';
import { startFreshSession } from './idle';

const url = import.meta.env.VITE_SUPABASE_URL as string;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!url || !key) {
  throw new Error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Copy .env.example to .env.local.');
}

let requestOrg: string | null = null;
export const setRequestOrg = (id: string | null) => { requestOrg = id; };
/** The organization data requests are for, for calls that carry it themselves (Edge Functions). */
export const requestOrgId = () => requestOrg;

// Tells the database which organization a data request is for. The database still checks the
// signed-in user belongs to it, so this only ever selects, it never grants.
// Data is never taken from a cache: every request goes to the database (cache: 'no-store'; the browser then also
// tells any proxy on the way not to answer from its cache). Moshe Henig, 2026-11-11: a new Task Sheet task only
// appeared after a hard refresh, which is what a cached answer looks like.
const orgFetch: typeof fetch = (input, init) => {
  const fresh: RequestInit = { ...init, cache: 'no-store' };
  if (!requestOrg || !String(input instanceof Request ? input.url : input).includes('/rest/v1/')) return fetch(input, fresh);
  const headers = new Headers(init?.headers);
  headers.set('x-org-id', requestOrg);
  return fetch(input, { ...fresh, headers });
};

// PKCE puts the email-link code in ?code= so it doesn't collide with HashRouter's #/ routes.
export const supabase = createClient(url, key, { auth: { flowType: 'pkce' }, global: { fetch: orgFetch } });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;

/** Records something the database can't see for itself. Never blocks or fails the action it describes. */
export async function logActivity(action: 'logout' | 'export', detail?: Row) {
  try {
    await supabase.rpc('log_activity', { p_action: action, p_detail: detail ?? null });
  } catch {
    // Logging must not get in the way of signing out or exporting.
  }
}

/** Signs in through the sign-in function, which enforces the account lockout. */
export async function signInWithPassword(email: string, password: string): Promise<{ error: { message: string } | null }> {
  const { data, error } = await supabase.functions.invoke('sign-in', { body: { email, password } });
  if (error) return { error: { message: 'Sign-in is unavailable right now. Please try again.' } };
  if (data.error) return { error: { message: data.error } };
  // Restart the idle clock first, so an old activity time can't sign this new session straight back out.
  startFreshSession();
  return supabase.auth.setSession(data.session);
}

type PageQuery =(from: number, to: number) => PromiseLike<{ data: Row[] | null; error: { message: string } | null }>;

/**
 * PostgREST caps responses at 1000 rows; page through until everything is loaded.
 * After the first page, requests go out a few at a time in parallel.
 */
export async function fetchAll(query: PageQuery, pageSize = 1000, parallel = 4): Promise<Row[]> {
  const page = async (n: number) => {
    const { data, error } = await query(n * pageSize, (n + 1) * pageSize - 1);
    if (error) throw new Error(error.message);
    return data ?? [];
  };
  const rows = await page(0);
  if (rows.length < pageSize) return rows;
  for (let next = 1; ; next += parallel) {
    const batch = await Promise.all(Array.from({ length: parallel }, (_, i) => page(next + i)));
    for (const b of batch) rows.push(...b);
    if (batch.some(b => b.length < pageSize)) return rows;
  }
}
