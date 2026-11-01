// Password sign-in with the spec's lockout: five wrong passwords in a row lock an account for an
// hour. Deployed with JWT verification off, since callers aren't signed in yet; the password is the
// authentication. Answers 200 with { session } or { error } so the app can show the message as is.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-org-id',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const LOCKED = 'Too many failed attempts. Please try again in 1 hour, or reset your password.';

const url = Deno.env.get('SUPABASE_URL')!;
const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const reply = (body: unknown) => Response.json(body, { headers: CORS });

async function rpc(name: string, args: unknown): Promise<unknown> {
  const res = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`${name}: ${res.status}`);
  return res.json();
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply({ error: 'Method not allowed' });

  let email: unknown, password: unknown;
  try {
    ({ email, password } = await req.json());
  } catch {
    return reply({ error: 'Enter your email and password.' });
  }
  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
    return reply({ error: 'Enter your email and password.' });
  }

  // If the lockout check itself fails, people can still sign in: a database hiccup shouldn't lock
  // everyone out of the system.
  try {
    if (await rpc('login_locked', { p_email: email }) === true) return reply({ error: LOCKED });
  } catch (e) {
    console.error('lockout check failed', e);
  }

  const auth = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await auth.json().catch(() => ({}));

  if (auth.ok) {
    await rpc('record_login_attempt', { p_email: email, p_valid: true }).catch(e => console.error(e));
    return reply({ session: { access_token: body.access_token, refresh_token: body.refresh_token } });
  }

  // Only a wrong password counts: not an unconfirmed email or a rate limit.
  if (body.error_code === 'invalid_credentials') {
    const locked = await rpc('record_login_attempt', { p_email: email, p_valid: false }).catch(e => console.error(e));
    return reply({ error: locked === true ? LOCKED : 'Invalid login credentials' });
  }
  return reply({ error: body.msg ?? body.message ?? 'Sign-in failed. Please try again.' });
});
