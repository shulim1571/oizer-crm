#!/usr/bin/env node
// Scheduled cloud-configuration monitor (.github/workflows/cloud-config.yml). Reads, never writes: provider APIs are
// called with GET only, and endpoint probes send no credentials to functions that refuse before doing anything.
// Everything specific to an organization comes from the environment (GitHub repository variables and secrets):
//   SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY          public values; anonymous-read and endpoint probes
//   SUPABASE_PROJECT_REF + SUPABASE_ACCESS_TOKEN    advisors, auth settings, functions, backups, database network
//   APP_URLS                                        comma-separated live addresses for header and certificate checks
//   CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN    read-only token (Pages: Read, Workers Scripts: Read)
//   CF_PAGES_PROJECTS, CF_WORKERS                   comma-separated names to check (only these are read)
// Expected values live in security/cloud-baseline.json. A missing credential is reported as a failure, not skipped.

import { readFileSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { connect } from 'node:tls';
import { join } from 'node:path';
import * as C from './cloudChecks.mjs';

const env = n => (process.env[n] ?? '').trim();
const list = n => env(n).split(',').map(s => s.trim()).filter(Boolean);
const root = new URL('../..', import.meta.url).pathname;
const baseline = JSON.parse(readFileSync(join(root, 'security/cloud-baseline.json'), 'utf8'));
const findings = [];
const add = f => findings.push(...(Array.isArray(f) ? f : [f]));

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, body };
}

async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

async function guarded(area, what, fn) {
  try { add(await fn()); } catch (e) { add(C.finding('fail', area, what, `check could not run: ${e?.name ?? 'error'}`)); }
}

// ---------------------------------------------------------------- Supabase, public side (no secret needed)
const sbUrl = env('SUPABASE_URL').replace(/\/$/, '');
const pk = env('SUPABASE_PUBLISHABLE_KEY');
if (!sbUrl || !pk) add(C.finding('fail', 'supabase', 'configuration', 'SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY variables are not set'));
else {
  await guarded('supabase', 'anonymous reads', async () => {
    const dir = join(root, 'supabase/migrations');
    const sql = readdirSync(dir).filter(f => f.endsWith('.sql')).map(f => readFileSync(join(dir, f), 'utf8')).join('\n');
    const names = C.objectNamesFromSql(sql);
    const results = await pool(names, 8, async name => {
      try {
        const r = await getJson(`${sbUrl}/rest/v1/${name}?select=*&limit=1`, { apikey: pk, Authorization: `Bearer ${pk}` });
        return { name, status: r.status, rows: r.status === 200 && Array.isArray(r.body) ? r.body.length : 0 };
      } catch { return { name, status: 0, rows: 0 }; }
    });
    return C.checkAnonReads(results, baseline.supabase);
  });

  await guarded('endpoints', 'unauthenticated requests', async () => {
    const fn = `${sbUrl}/functions/v1`;
    const probe = async (name, url, init, expect) => {
      try { return { name, status: (await fetch(url, { ...init, signal: AbortSignal.timeout(30000) })).status, expect }; }
      catch { return { name, status: 0, expect }; }
    };
    const post = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' };
    return C.checkProbes(await Promise.all([
      probe('api (read API)', `${fn}/api/v1/donations`, {}, [401]),
      probe('make-ingest', `${fn}/make-ingest?org=00000000-0000-0000-0000-000000000000&source=sola`, post, [401]),
      probe('assistant', `${fn}/assistant`, post, [401]),
      probe('plaid', `${fn}/plaid`, post, [401]),
    ]));
  });
}

// ---------------------------------------------------------------- Supabase management API (read-only token)
const ref = env('SUPABASE_PROJECT_REF');
const sbToken = env('SUPABASE_ACCESS_TOKEN');
if (!ref || !sbToken) add(C.finding('fail', 'supabase', 'configuration', 'SUPABASE_PROJECT_REF variable or SUPABASE_ACCESS_TOKEN secret is not set: advisors, auth, functions and backups unchecked'));
else {
  const api = p => getJson(`https://api.supabase.com/v1/projects/${ref}${p}`, { Authorization: `Bearer ${sbToken}` }).then(r => {
    if (r.status !== 200) throw Object.assign(new Error(), { name: `HTTP ${r.status}` });
    return r.body;
  });
  await guarded('supabase', 'security advisors', async () => {
    const lints = (await api('/advisors/security')).lints ?? [];
    return [...C.checkAdvisors(lints, baseline.supabase), ...C.checkAnonFunctions(lints, baseline.supabase)];
  });
  await guarded('supabase', 'auth settings', async () => {
    const cfg = await api('/config/auth');
    // Only the baseline's keys leave this function, and only plain numbers and booleans are ever shown.
    const keys = [...Object.keys(baseline.supabase.auth_equals ?? {}), ...Object.keys(baseline.supabase.auth_at_least ?? {}), ...Object.keys(baseline.supabase.auth_at_most ?? {})];
    const safe = Object.fromEntries(keys.map(k => [k, ['number', 'boolean'].includes(typeof cfg[k]) || cfg[k] === null ? cfg[k] : '(not shown)']));
    return C.checkAuthConfig(safe, baseline.supabase);
  });
  await guarded('supabase', 'edge functions', async () => C.checkFunctions((await api('/functions')).map(f => ({ slug: f.slug, verify_jwt: f.verify_jwt })), baseline.supabase));
  await guarded('supabase', 'backups', async () => C.checkBackups(await api('/database/backups'), baseline.supabase));
  await guarded('supabase', 'database connections', async () => C.checkDatabaseNetwork(await api('/ssl-enforcement'), await api('/network-restrictions'), baseline.supabase));
}

// ---------------------------------------------------------------- Live site
function certDaysLeft(host) {
  return new Promise((resolve, reject) => {
    const s = connect({ host, port: 443, servername: host, timeout: 20000 }, () => {
      const c = s.getPeerCertificate();
      s.end();
      resolve(Math.floor((Date.parse(c.valid_to) - Date.now()) / 864e5));
    });
    s.on('error', reject);
    s.on('timeout', () => { s.destroy(); reject(new Error('timeout')); });
  });
}
for (const url of list('APP_URLS')) {
  await guarded('site', url, async () => {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30000) });
    const headers = Object.fromEntries([...res.headers.entries()].map(([k, v]) => [k.toLowerCase(), v]));
    const host = new URL(url).hostname;
    let httpRedirect;
    try {
      const h = await fetch(`http://${host}/`, { redirect: 'manual', signal: AbortSignal.timeout(30000) });
      httpRedirect = [301, 302, 307, 308].includes(h.status) && (h.headers.get('location') ?? '').startsWith('https://');
    } catch { httpRedirect = false; }
    return C.checkSite(url, { headers, httpRedirect, certDaysLeft: await certDaysLeft(host) }, baseline.site);
  });
}

// ---------------------------------------------------------------- Cloudflare (read-only token; named resources only)
const acct = env('CLOUDFLARE_ACCOUNT_ID');
const cfToken = env('CLOUDFLARE_API_TOKEN');
if (!acct || !cfToken) add(C.finding('fail', 'cloudflare', 'configuration', 'CLOUDFLARE_ACCOUNT_ID variable or CLOUDFLARE_API_TOKEN secret is not set: Pages and Workers unchecked'));
else {
  const cf = p => getJson(`https://api.cloudflare.com/client/v4/accounts/${acct}${p}`, { Authorization: `Bearer ${cfToken}` }).then(r => {
    if (r.status !== 200 || !r.body?.success) throw Object.assign(new Error(), { name: `HTTP ${r.status}` });
    return r.body.result;
  });
  for (const name of list('CF_PAGES_PROJECTS')) {
    await guarded('cloudflare', `pages ${name}`, async () => {
      const p = await cf(`/pages/projects/${encodeURIComponent(name)}`);
      // Keep names and types only; plain-text values never leave this function.
      const deployment_configs = Object.fromEntries(Object.entries(p.deployment_configs ?? {}).map(([k, v]) =>
        [k, { env_vars: Object.fromEntries(Object.entries(v?.env_vars ?? {}).map(([n, x]) => [n, { type: x?.type }])) }]));
      return C.checkPagesProject({ name: p.name, production_branch: p.production_branch, domains: p.domains, deployment_configs }, baseline.cloudflare);
    });
  }
  for (const name of list('CF_WORKERS')) {
    await guarded('cloudflare', `worker ${name}`, async () => {
      const s = await cf(`/workers/scripts/${encodeURIComponent(name)}/settings`);
      const sd = await cf(`/workers/scripts/${encodeURIComponent(name)}/subdomain`);
      return C.checkWorker(name, { bindings: (s.bindings ?? []).map(b => ({ name: b.name, type: b.type })), workersDev: sd?.enabled === true }, baseline.cloudflare);
    });
  }
}

// ---------------------------------------------------------------- Report
const { markdown, failed } = C.report(findings);
console.log(markdown);
if (env('GITHUB_STEP_SUMMARY')) appendFileSync(env('GITHUB_STEP_SUMMARY'), markdown + '\n');
if (env('REPORT_PATH')) writeFileSync(env('REPORT_PATH'), JSON.stringify({ at: new Date().toISOString(), findings }, null, 1));
process.exit(failed ? 1 : 0);
