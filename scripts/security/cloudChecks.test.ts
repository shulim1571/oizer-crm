import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as C from './cloudChecks.mjs';

const baseline = JSON.parse(readFileSync(new URL('../../security/cloud-baseline.json', import.meta.url), 'utf8'));
const levels = (f: { level: string }[]) => f.map(x => x.level);
const lint = (name: string, level = 'WARN', metadata: Record<string, string> = {}) => ({ name, level, title: name, metadata });

describe('cloud configuration checks', () => {
  it('advisors: an ERROR fails, a new or grown lint fails, the baseline passes', () => {
    const base = { advisor_max_counts: { function_search_path_mutable: 1 } };
    expect(levels(C.checkAdvisors([lint('function_search_path_mutable')], base))).toEqual(['ok']);
    expect(levels(C.checkAdvisors([lint('rls_disabled_in_public', 'ERROR')], base))).toContain('fail');
    expect(levels(C.checkAdvisors([lint('function_search_path_mutable'), lint('function_search_path_mutable')], base))).toEqual(['fail']);
    expect(levels(C.checkAdvisors([lint('extension_in_public')], base))).toContain('fail');
    expect(levels(C.checkAdvisors([], base))).toEqual(['warn', 'ok']);   // fewer than the baseline: lower it
  });

  it('a newly anonymous-callable function fails until reviewed', () => {
    const l = (n: string) => lint('anon_security_definer_function_executable', 'WARN', { name: n });
    expect(levels(C.checkAnonFunctions([l('public_give_page')], baseline.supabase))).toEqual(['ok']);
    expect(C.checkAnonFunctions([l('delete_everything')], baseline.supabase)[0]).toMatchObject({ level: 'fail', detail: expect.stringContaining('delete_everything') });
  });

  it('auth settings: weakening MFA, password length or session limits fails', () => {
    const good = { mfa_totp_enroll_enabled: true, mfa_totp_verify_enabled: true, password_hibp_enabled: true, mailer_autoconfirm: false,
      external_anonymous_users_enabled: false, refresh_token_rotation_enabled: true, password_min_length: 12, sessions_timebox: 12, sessions_inactivity_timeout: 0.5, jwt_exp: 3600 };
    expect(levels(C.checkAuthConfig(good, baseline.supabase))).toEqual(['ok']);
    expect(levels(C.checkAuthConfig({ ...good, password_min_length: 8 }, baseline.supabase))).toEqual(['fail']);
    expect(levels(C.checkAuthConfig({ ...good, mfa_totp_verify_enabled: false }, baseline.supabase))).toEqual(['fail']);
    expect(levels(C.checkAuthConfig({ ...good, sessions_timebox: 0 }, baseline.supabase))).toEqual(['fail']);   // 0 = no limit
  });

  it('a new edge function with JWT checks off fails until reviewed', () => {
    expect(levels(C.checkFunctions([{ slug: 'give', verify_jwt: false }, { slug: 'health', verify_jwt: true }], baseline.supabase))).toEqual(['ok']);
    expect(levels(C.checkFunctions([{ slug: 'new-thing', verify_jwt: false }], baseline.supabase))).toEqual(['fail']);
  });

  it('backups must be recent', () => {
    const now = Date.parse('2026-11-12T12:00:00Z');
    expect(levels(C.checkBackups({ pitr_enabled: false, backups: [{ status: 'COMPLETED', inserted_at: '2026-11-12T01:00:00Z' }] }, baseline.supabase, now))).toEqual(['ok']);
    expect(levels(C.checkBackups({ pitr_enabled: false, backups: [{ status: 'COMPLETED', inserted_at: '2026-11-09T01:00:00Z' }] }, baseline.supabase, now))).toEqual(['fail']);
    expect(levels(C.checkBackups({ backups: [] }, baseline.supabase, now))).toEqual(['fail']);
  });

  it('database network: known gaps warn; any drift from the baseline fails', () => {
    const open = { config: { dbAllowedCidrs: ['0.0.0.0/0'], dbAllowedCidrsV6: ['::/0'] } };
    expect(levels(C.checkDatabaseNetwork({ currentConfig: { database: false } }, open, baseline.supabase))).toEqual(['warn', 'warn']);
    expect(levels(C.checkDatabaseNetwork({ currentConfig: { database: true } }, { config: { dbAllowedCidrs: ['1.2.3.4/32'] } }, { db_ssl_enforced: true, db_open_to_all_ips: false }))).toEqual(['ok']);
    expect(levels(C.checkDatabaseNetwork({ currentConfig: { database: false } }, { config: { dbAllowedCidrs: ['1.2.3.4/32'] } }, { db_ssl_enforced: true, db_open_to_all_ips: false }))).toEqual(['fail']);
  });

  it('anonymous reads: any table returning rows to a signed-out visitor fails', () => {
    expect(levels(C.checkAnonReads([{ name: 'donations', status: 401, rows: 0 }, { name: 'org_pages', status: 200, rows: 0 }], baseline.supabase))).toEqual(['ok']);
    expect(C.checkAnonReads([{ name: 'donors', status: 200, rows: 1 }], baseline.supabase)[0]).toMatchObject({ level: 'fail', detail: expect.stringContaining('donors') });
  });

  it('endpoints answering without credentials fail', () => {
    expect(levels(C.checkProbes([{ name: 'api', status: 401, expect: [401] }]))).toEqual(['ok']);
    expect(levels(C.checkProbes([{ name: 'api', status: 200, expect: [401] }]))).toEqual(['fail']);
  });

  it('site: missing headers, short HSTS, no HTTPS redirect or an expiring certificate fail', () => {
    const headers = { 'strict-transport-security': 'max-age=31536000; includeSubDomains', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'strict-origin-when-cross-origin' };
    expect(levels(C.checkSite('u', { headers, httpRedirect: true, certDaysLeft: 60 }, baseline.site))).toEqual(['ok']);
    expect(levels(C.checkSite('u', { headers: { ...headers, 'x-frame-options': undefined }, httpRedirect: true, certDaysLeft: 60 }, baseline.site))).toEqual(['fail']);
    expect(levels(C.checkSite('u', { headers: { ...headers, 'strict-transport-security': 'max-age=60' }, httpRedirect: true, certDaysLeft: 60 }, baseline.site))).toEqual(['fail']);
    expect(levels(C.checkSite('u', { headers, httpRedirect: false, certDaysLeft: 5 }, baseline.site))).toEqual(['fail', 'fail']);
  });

  it('Cloudflare: secret-looking values in plain text fail; wrong branch or missing domain fail', () => {
    const p = { name: 'oizer-drm', production_branch: 'main', domains: ['oizer.trubase.org'], deployment_configs: { production: { env_vars: { GIVE_GATE_SECRET: { type: 'secret_text' }, VITE_FLAG: { type: 'plain_text' } } } } };
    expect(levels(C.checkPagesProject(p, baseline.cloudflare))).toEqual(['ok']);
    expect(levels(C.checkPagesProject({ ...p, deployment_configs: { production: { env_vars: { API_TOKEN: { type: 'plain_text' } } } } }, baseline.cloudflare))).toEqual(['fail']);
    expect(levels(C.checkPagesProject({ ...p, production_branch: 'dev', domains: [] }, baseline.cloudflare))).toEqual(['fail', 'fail']);
    expect(levels(C.checkWorker('oizer-give-gate', { bindings: [{ name: 'GIVE_GATE_SECRET', type: 'secret_text' }], workersDev: true }, baseline.cloudflare))).toEqual(['ok']);
    expect(levels(C.checkWorker('oizer-give-gate', { bindings: [{ name: 'SENDGRID_KEY', type: 'plain_text' }], workersDev: false }, baseline.cloudflare))).toEqual(['fail', 'fail']);
  });

  it('reads table and view names from migrations; the report fails when anything fails', () => {
    expect(C.objectNamesFromSql('create table public.a (x int); CREATE OR REPLACE VIEW public.b as select 1; create table if not exists public.a ();')).toEqual(['a', 'b']);
    expect(C.report([C.finding('ok', 'x', 'y')]).failed).toBe(false);
    const r = C.report([C.finding('ok', 'x', 'y'), C.finding('fail', 'x', 'z', 'a|b')]);
    expect(r.failed).toBe(true);
    expect(r.markdown).toContain('a\\|b');
  });

  it('the baseline holds no secret values', () => {
    const text = readFileSync(new URL('../../security/cloud-baseline.json', import.meta.url), 'utf8');
    expect(text).not.toMatch(/sb_(secret|publishable)_|eyJ[A-Za-z0-9_-]{20,}|sbp_[0-9a-f]{20,}|dbk_[0-9a-f]{20,}/);
  });
});
