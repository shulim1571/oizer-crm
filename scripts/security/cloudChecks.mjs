// Cloud-configuration checks (Plaid security attestation, 2026-11-12): pure functions that compare what Supabase,
// Cloudflare and the live site report against security/cloud-baseline.json. No network here; cloud-check.mjs fetches.
// Each check returns findings { level: 'fail' | 'warn' | 'ok', area, check, detail }. Details never include secret
// values: callers pass only names, flags and counts.

export const finding = (level, area, check, detail = '') => ({ level, area, check, detail });

const SECRETISH = /(KEY|SECRET|TOKEN|PASSWORD|PASS|PRIVATE|CREDENTIAL|AUTH)/i;

/** Supabase security advisors: any ERROR fails; a lint that is new or grew past its baseline count fails. */
export function checkAdvisors(lints, baseline) {
  const out = [];
  const failLevels = new Set(baseline.advisor_fail_levels ?? ['ERROR']);
  const counts = {};
  for (const l of lints) {
    counts[l.name] = (counts[l.name] ?? 0) + 1;
    if (failLevels.has(l.level)) out.push(finding('fail', 'supabase', `advisor ${l.name}`, `${l.level}: ${l.title ?? ''}`.trim()));
  }
  const max = baseline.advisor_max_counts ?? {};
  for (const [name, n] of Object.entries(counts)) {
    if (!(name in max)) out.push(finding('fail', 'supabase', `advisor ${name}`, `new advisor finding (${n}); review, fix or add to the baseline with a reason`));
    else if (n > max[name]) out.push(finding('fail', 'supabase', `advisor ${name}`, `${n} now, baseline ${max[name]}`));
    else if (n < max[name]) out.push(finding('warn', 'supabase', `advisor ${name}`, `${n} now, baseline ${max[name]}: lower the baseline`));
  }
  for (const [name, n] of Object.entries(max)) {
    if (!(name in counts) && n > 0) out.push(finding('warn', 'supabase', `advisor ${name}`, `0 now, baseline ${n}: lower the baseline`));
  }
  if (!out.some(f => f.level === 'fail')) out.push(finding('ok', 'supabase', 'security advisors', `${lints.length} findings, none new or above baseline`));
  return out;
}

/** Functions anyone (signed out) can call with SECURITY DEFINER rights must each be on the reviewed list. */
export function checkAnonFunctions(lints, baseline) {
  const allowed = new Set(baseline.anon_executable_functions ?? []);
  const names = lints.filter(l => l.name === 'anon_security_definer_function_executable').map(l => l.metadata?.name).filter(Boolean);
  const extra = names.filter(n => !allowed.has(n));
  return extra.length
    ? extra.map(n => finding('fail', 'supabase', 'anonymous-callable function', `${n} is callable signed out and not on the reviewed list`))
    : [finding('ok', 'supabase', 'anonymous-callable functions', `${names.length}, all reviewed`)];
}

/** Auth settings: exact values and minimums from the baseline. */
export function checkAuthConfig(cfg, baseline) {
  const out = [];
  for (const [k, v] of Object.entries(baseline.auth_equals ?? {})) {
    if (cfg[k] !== v) out.push(finding('fail', 'supabase', `auth ${k}`, `is ${JSON.stringify(cfg[k])}, expected ${JSON.stringify(v)}`));
  }
  for (const [k, v] of Object.entries(baseline.auth_at_least ?? {})) {
    if (!(typeof cfg[k] === 'number' && cfg[k] >= v)) out.push(finding('fail', 'supabase', `auth ${k}`, `is ${JSON.stringify(cfg[k])}, expected at least ${v}`));
  }
  for (const [k, v] of Object.entries(baseline.auth_at_most ?? {})) {
    if (!(typeof cfg[k] === 'number' && cfg[k] > 0 && cfg[k] <= v)) out.push(finding('fail', 'supabase', `auth ${k}`, `is ${JSON.stringify(cfg[k])}, expected at most ${v}`));
  }
  if (!out.length) out.push(finding('ok', 'supabase', 'auth settings', 'match the baseline'));
  return out;
}

/** Edge functions: each one with gateway JWT checks off must be on the reviewed list (it authenticates itself). */
export function checkFunctions(fns, baseline) {
  const allowed = new Set(baseline.functions_without_jwt_verification ?? []);
  const out = fns.filter(f => f.verify_jwt === false && !allowed.has(f.slug))
    .map(f => finding('fail', 'supabase', 'edge function JWT', `${f.slug} has JWT verification off and is not on the reviewed list`));
  if (!out.length) out.push(finding('ok', 'supabase', 'edge functions', `${fns.length} deployed, JWT settings as reviewed`));
  return out;
}

/** Backups: the newest completed backup must be recent. */
export function checkBackups(b, baseline, now = Date.now()) {
  const done = (b?.backups ?? []).filter(x => x.status === 'COMPLETED').map(x => Date.parse(x.inserted_at)).filter(Number.isFinite);
  if (!done.length) return [finding('fail', 'supabase', 'backups', 'no completed backup listed')];
  const hours = (now - Math.max(...done)) / 36e5;
  const max = baseline.backup_max_age_hours ?? 36;
  const out = [hours > max ? finding('fail', 'supabase', 'backups', `newest backup is ${Math.round(hours)} h old (limit ${max} h)`)
    : finding('ok', 'supabase', 'backups', `newest ${Math.round(hours)} h old, ${done.length} kept`)];
  if (b.pitr_enabled !== baseline.pitr_enabled) out.push(finding('warn', 'supabase', 'point-in-time recovery', `is ${b.pitr_enabled ? 'on' : 'off'}, baseline ${baseline.pitr_enabled ? 'on' : 'off'}`));
  return out;
}

/** Database connection settings the baseline records (SSL enforcement, network allowlist). Drift fails. */
export function checkDatabaseNetwork(ssl, net, baseline) {
  const out = [];
  const enforced = ssl?.currentConfig?.database === true;
  if (enforced !== baseline.db_ssl_enforced) out.push(finding('fail', 'supabase', 'database SSL enforcement', `is ${enforced ? 'on' : 'off'}, baseline ${baseline.db_ssl_enforced ? 'on' : 'off'}`));
  else if (!enforced) out.push(finding('warn', 'supabase', 'database SSL enforcement', 'off (known gap)'));
  const open = [...(net?.config?.dbAllowedCidrs ?? []), ...(net?.config?.dbAllowedCidrsV6 ?? [])].some(c => c === '0.0.0.0/0' || c === '::/0');
  if (open !== baseline.db_open_to_all_ips) out.push(finding('fail', 'supabase', 'database network restrictions', `${open ? 'open to all addresses' : 'restricted'}, baseline ${baseline.db_open_to_all_ips ? 'open' : 'restricted'}`));
  else if (open) out.push(finding('warn', 'supabase', 'database network restrictions', 'open to all addresses (known gap)'));
  if (!out.length) out.push(finding('ok', 'supabase', 'database connections', 'SSL enforced and network restricted'));
  return out;
}

/** Anonymous reads through the public data API: every table and view must refuse or come back empty. */
export function checkAnonReads(results, baseline) {
  const allowed = new Set(baseline.anon_readable ?? []);
  const out = [];
  for (const r of results) {
    if (r.rows > 0 && !allowed.has(r.name)) out.push(finding('fail', 'supabase', 'anonymous read', `${r.name} returned rows to a signed-out visitor`));
    else if (r.status >= 500 || r.status === 0) out.push(finding('warn', 'supabase', 'anonymous read', `${r.name}: no clear answer (${r.status})`));
  }
  if (!out.some(f => f.level === 'fail')) out.push(finding('ok', 'supabase', 'anonymous reads', `${results.length} tables and views, none readable signed out`));
  return out;
}

/** Endpoints that must refuse a request with no credentials. */
export function checkProbes(results) {
  const out = results.filter(r => !r.expect.includes(r.status))
    .map(r => finding('fail', 'endpoints', r.name, `answered ${r.status} without credentials, expected ${r.expect.join(' or ')}`));
  if (!out.length) out.push(finding('ok', 'endpoints', 'unauthenticated requests', `${results.length} endpoints refuse them`));
  return out;
}

/** Live site: HTTPS redirect, security headers, certificate lifetime. headers keys are lower case. */
export function checkSite(url, { headers, httpRedirect, certDaysLeft }, baseline) {
  const out = [];
  const need = baseline.site_headers ?? {};
  for (const [h, pattern] of Object.entries(need)) {
    const v = headers[h.toLowerCase()];
    if (v == null) out.push(finding('fail', 'site', `${url} ${h}`, 'missing'));
    else if (!new RegExp(pattern, 'i').test(v)) out.push(finding('fail', 'site', `${url} ${h}`, `is "${v}", expected /${pattern}/`));
  }
  const hsts = /max-age=(\d+)/i.exec(headers['strict-transport-security'] ?? '');
  if (hsts && Number(hsts[1]) < (baseline.hsts_min_seconds ?? 15552000)) out.push(finding('fail', 'site', `${url} HSTS`, `max-age ${hsts[1]} is too short`));
  if (httpRedirect !== undefined && httpRedirect !== true) out.push(finding('fail', 'site', `${url} HTTP`, 'plain HTTP does not redirect to HTTPS'));
  if (certDaysLeft !== undefined && certDaysLeft < (baseline.cert_min_days ?? 14)) out.push(finding('fail', 'site', `${url} certificate`, `expires in ${certDaysLeft} days`));
  if (!out.length) out.push(finding('ok', 'site', url, `headers present${certDaysLeft !== undefined ? `, certificate ${certDaysLeft} days left` : ''}`));
  return out;
}

/** Cloudflare Pages project: production branch, custom domains, no secret-looking value stored as plain text. */
export function checkPagesProject(p, baseline) {
  const out = [];
  const want = baseline.pages ?? {};
  if (want.production_branch && p.production_branch !== want.production_branch) out.push(finding('fail', 'cloudflare', `pages ${p.name}`, `production branch is ${p.production_branch}, expected ${want.production_branch}`));
  for (const d of want.domains ?? []) if (!(p.domains ?? []).includes(d)) out.push(finding('fail', 'cloudflare', `pages ${p.name}`, `custom domain ${d} missing`));
  for (const [env, cfg] of Object.entries(p.deployment_configs ?? {})) {
    for (const [name, v] of Object.entries(cfg?.env_vars ?? {})) {
      if (SECRETISH.test(name) && v?.type !== 'secret_text') out.push(finding('fail', 'cloudflare', `pages ${p.name}`, `${env} variable ${name} looks secret but is stored as plain text`));
    }
  }
  if (!out.length) out.push(finding('ok', 'cloudflare', `pages ${p.name}`, 'branch, domains and variables as expected'));
  return out;
}

/** Cloudflare Worker: secret-looking bindings must be secrets; workers.dev exposure as the baseline records. */
export function checkWorker(name, { bindings, workersDev }, baseline) {
  const out = [];
  for (const b of bindings ?? []) {
    if (SECRETISH.test(b.name) && b.type === 'plain_text') out.push(finding('fail', 'cloudflare', `worker ${name}`, `binding ${b.name} looks secret but is plain text`));
  }
  const want = (baseline.workers ?? {})[name];
  if (want && typeof want.workers_dev === 'boolean' && workersDev !== want.workers_dev) {
    out.push(finding('fail', 'cloudflare', `worker ${name}`, `workers.dev address is ${workersDev ? 'on' : 'off'}, baseline ${want.workers_dev ? 'on' : 'off'}`));
  }
  if (!out.length) out.push(finding('ok', 'cloudflare', `worker ${name}`, 'secrets stored as secrets; exposure as expected'));
  return out;
}

/** Markdown report for the job summary, and whether the run fails. */
export function report(findings) {
  const icon = { fail: '❌', warn: '⚠️', ok: '✅' };
  const order = { fail: 0, warn: 1, ok: 2 };
  const sorted = [...findings].sort((a, b) => order[a.level] - order[b.level]);
  const n = l => findings.filter(f => f.level === l).length;
  const lines = [`## Cloud configuration check`, '', `${n('fail')} failing, ${n('warn')} warnings, ${n('ok')} passing`, '',
    '| | Area | Check | Detail |', '|---|---|---|---|',
    ...sorted.map(f => `| ${icon[f.level]} | ${f.area} | ${f.check} | ${String(f.detail).replace(/\|/g, '\\|')} |`)];
  return { markdown: lines.join('\n'), failed: n('fail') > 0 };
}

/** Table and view names from the repository's own migrations (the public data API hides its schema from visitors). */
export function objectNamesFromSql(sql) {
  const re = /create\s+(?:or\s+replace\s+)?(?:materialized\s+)?(?:table|view)\s+(?:if\s+not\s+exists\s+)?public\.([a-z_0-9]+)/gi;
  return [...new Set([...sql.matchAll(re)].map(m => m[1].toLowerCase()))].sort();
}
