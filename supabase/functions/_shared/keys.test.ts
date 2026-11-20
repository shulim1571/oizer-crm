import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { apiHeaders, pickKey, publishableKey, secretKey } from './keys';

// Retiring the legacy JWT keys (Shulim, 2026-11-17): functions use only sb_secret_ / sb_publishable_ keys.
const env = (o: Record<string, string>) => (k: string) => o[k];
const S = '{"default":"sb_secret_abc"}';
const P = '{"default":"sb_publishable_xyz"}';

describe('function API keys', () => {
  it('reads the keys Supabase provides (JSON by name, "default" first)', () => {
    expect(pickKey(S)).toBe('sb_secret_abc');
    expect(pickKey('{"other":"sb_secret_o","default":"sb_secret_d"}')).toBe('sb_secret_d');
    expect(pickKey('sb_secret_plain')).toBe('sb_secret_plain');
    expect(pickKey('')).toBeNull();
    expect(secretKey(env({ SUPABASE_SECRET_KEYS: S }))).toBe('sb_secret_abc');
    expect(publishableKey(env({ SUPABASE_PUBLISHABLE_KEYS: P }))).toBe('sb_publishable_xyz');
    expect(secretKey(env({ OIZER_SECRET_KEY: 'sb_secret_fallback' }))).toBe('sb_secret_fallback');
  });

  it('never falls back to the legacy JWT keys', () => {
    const legacy = env({ SUPABASE_SERVICE_ROLE_KEY: 'eyJhbGciOiJIUzI1NiJ9.x.y', SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiJ9.a.b' });
    expect(() => secretKey(legacy)).toThrow(/sb_secret_/);
    expect(() => publishableKey(legacy)).toThrow(/sb_publishable_/);
    expect(() => secretKey(env({ OIZER_SECRET_KEY: 'eyJhbGciOiJIUzI1NiJ9.x.y' }))).toThrow();
  });

  it('puts the secret key on apikey alone, and a person’s token with the publishable key', () => {
    const e = env({ SUPABASE_SECRET_KEYS: S, SUPABASE_PUBLISHABLE_KEYS: P });
    expect(apiHeaders(null, e)).toEqual({ apikey: 'sb_secret_abc' });
    expect(apiHeaders('user.jwt.token', e)).toEqual({ apikey: 'sb_publishable_xyz', Authorization: 'Bearer user.jwt.token' });
  });

  it('no function reads SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY', () => {
    const dir = 'supabase/functions';
    for (const f of readdirSync(dir)) {
      if (f.startsWith('_') || f.startsWith('.')) continue;
      const src = readFileSync(`${dir}/${f}/index.ts`, 'utf8');
      expect(src, f).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY|SUPABASE_ANON_KEY/);
    }
  });
});
