// The project's API keys for calls a function makes to its own database and auth (2026-11-17).
//
// Functions use the new keys only: sb_secret_… (server calls that skip row-level security) and sb_publishable_…
// (calls made as the signed-in person, with their token). Supabase hands both to every function as
// SUPABASE_SECRET_KEYS / SUPABASE_PUBLISHABLE_KEYS, JSON objects keyed by key name ("default"). If a project ever
// lacks them, a function secret OIZER_SECRET_KEY / OIZER_PUBLISHABLE_KEY can stand in. The legacy anon and
// service_role JWTs are never read, so turning them off breaks nothing here.
//
// The new keys aren't JWTs: they go on the apikey header. Authorization carries only a person's own token.

type Get = (name: string) => string | undefined;
const denoGet: Get = name => Deno.env.get(name);

/** One key out of a value Supabase provides: a JSON object of named keys ("default" first), or a plain key. */
export function pickKey(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s.startsWith('{')) return s || null;
  try {
    const o = JSON.parse(s) as Record<string, unknown>;
    const v = o.default ?? Object.values(o)[0];
    return typeof v === 'string' && v ? v : null;
  } catch {
    return null;
  }
}

function key(kind: 'secret' | 'publishable', get: Get): string {
  const k = kind === 'secret'
    ? pickKey(get('SUPABASE_SECRET_KEYS')) ?? pickKey(get('OIZER_SECRET_KEY'))
    : pickKey(get('SUPABASE_PUBLISHABLE_KEYS')) ?? pickKey(get('OIZER_PUBLISHABLE_KEY'));
  const prefix = kind === 'secret' ? 'sb_secret_' : 'sb_publishable_';
  if (!k || !k.startsWith(prefix)) throw new Error(`No ${prefix}… key available to this function`);
  return k;
}

/** The sb_secret_… key: server calls that skip row-level security. Never sent to a browser. */
export const secretKey = (get: Get = denoGet) => key('secret', get);
/** The sb_publishable_… key: calls made with a signed-in person's own token. */
export const publishableKey = (get: Get = denoGet) => key('publishable', get);

/**
 * Headers for a call to this project's REST or auth API: as the person, when their token is given (publishable key
 * plus their token); otherwise as the server (secret key alone on apikey).
 */
export function apiHeaders(userToken?: string | null, get: Get = denoGet): Record<string, string> {
  return userToken
    ? { apikey: publishableKey(get), Authorization: `Bearer ${userToken}` }
    : { apikey: secretKey(get) };
}
