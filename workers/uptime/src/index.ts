// Independent uptime monitoring and the public status page. Runs on Cloudflare, not Supabase, so it can report
// Supabase being down. Every 5 minutes it checks the app, the database and scheduled jobs, sign-in and the public
// API, keeps 90 days of results in Workers KV, and (when ALERT_EMAIL and SENDGRID_KEY are set) emails when
// something goes down or comes back.
//
//   GET /             the status page
//   GET /status.json  the same, for other tools

import { apply, overall, runCheck, uptime, type Check, type Current, type History, type Incident } from './status';
import { page } from './page';

interface Env {
  STATUS: KVNamespace;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  APP_URLS: string;          // comma-separated
  TITLE: string;
  ALERT_EMAIL?: string;
  ALERT_FROM?: string;
  SENDGRID_KEY?: string;
}

function checks(env: Env): Check[] {
  const api = { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${env.SUPABASE_ANON_KEY}` };
  return [
    ...env.APP_URLS.split(',').map(u => u.trim()).filter(Boolean).map(u => ({ name: `App (${new URL(u).hostname})`, url: u })),
    { name: 'Database and scheduled jobs', url: `${env.SUPABASE_URL}/functions/v1/health`, headers: api,
      expect: (s, b) => s === 200 && /"status"\s*:\s*"ok"/.test(b) },
    { name: 'Sign-in', url: `${env.SUPABASE_URL}/auth/v1/health`, headers: { apikey: env.SUPABASE_ANON_KEY } },
    { name: 'Public API', url: `${env.SUPABASE_URL}/functions/v1/api/v1` },
  ];
}

async function load(env: Env) {
  const [current, history, incidents] = await Promise.all([
    env.STATUS.get<Current>('current', 'json'), env.STATUS.get<History>('history', 'json'), env.STATUS.get<Incident[]>('incidents', 'json'),
  ]);
  return { current, history: history ?? {}, incidents: incidents ?? [] };
}

async function alert(env: Env, changed: { name: string; up: boolean; detail: string }[]) {
  if (!changed.length || !env.ALERT_EMAIL || !env.SENDGRID_KEY) return;
  const lines = changed.map(c => `${c.up ? 'Back up' : 'DOWN'}: ${c.name} (${c.detail})`);
  await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.SENDGRID_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: env.ALERT_EMAIL.split(',').map(e => ({ to: [{ email: e.trim() }] })),
      from: { email: env.ALERT_FROM || env.ALERT_EMAIL.split(',')[0].trim() },
      subject: `${env.TITLE}: ${changed.some(c => !c.up) ? 'something is down' : 'all back up'}`,
      content: [{ type: 'text/plain', value: lines.join('\n') }],
    }),
  }).catch(() => null);
}

export default {
  async scheduled(_e: ScheduledController, env: Env) {
    const results = await Promise.all(checks(env).map(c => runCheck(c)));
    const before = await load(env);
    const next = apply(before.current, before.history, before.incidents, results, new Date());
    const writes = [env.STATUS.put('current', JSON.stringify(next.current)), env.STATUS.put('history', JSON.stringify(next.history))];
    if (next.changed.length) writes.push(env.STATUS.put('incidents', JSON.stringify(next.incidents)));
    await Promise.all(writes);
    await alert(env, next.changed.filter(c => before.current || !c.up));
  },

  async fetch(req: Request, env: Env) {
    const path = new URL(req.url).pathname;
    if (path !== '/' && path !== '/status.json') return new Response('Not found', { status: 404 });
    const { current, history, incidents } = await load(env);
    const now = new Date();
    if (path === '/status.json') {
      const components = Object.entries(current?.components ?? {}).map(([name, c]) => ({
        name, ...c, uptime_7d: uptime(history, name, 7, now), uptime_90d: uptime(history, name, 90, now),
      }));
      return Response.json({ status: overall(current), checked_at: current?.checked_at ?? null, components, incidents: incidents.slice(0, 10) },
        { headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'max-age=60' } });
    }
    return new Response(page(env.TITLE, current, history, incidents, now), {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'max-age=60', 'X-Robots-Tag': 'noindex' },
    });
  },
};
