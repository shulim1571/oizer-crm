import { supabase } from './supabase';

// Trusted devices for two-step verification (Moshe Henig, 2026-11-11). The browser keeps a random token; the
// database keeps only its hash, trusts it for 30 days after a code, and also recognizes an address used with a
// code in the last 7 days (see the mfa_trusted_devices migration).
export const TRUST_DAYS = 30;
const KEY = 'oizer-trusted-device';

export function deviceToken(): string {
  try {
    const have = localStorage.getItem(KEY);
    if (have && /^[A-Za-z0-9_-]{32,128}$/.test(have)) return have;
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    localStorage.setItem(KEY, token);
    return token;
  } catch {
    return '';
  }
}

/** At sign-in: 'device' or 'address' when this sign-in is trusted (no code needed), otherwise null. */
export async function checkTrustedSignIn(): Promise<'device' | 'address' | null> {
  const token = deviceToken();
  const { data, error } = await supabase.rpc('mfa_use_trusted', { p_token: token || null });
  return error ? null : ((data as 'device' | 'address' | null) ?? null);
}

/** After a correct code: trust this browser for TRUST_DAYS days. */
export async function trustThisDevice(): Promise<void> {
  const token = deviceToken();
  if (!token) return;
  await supabase.rpc('mfa_trust_this_device', { p_token: token, p_user_agent: navigator.userAgent.slice(0, 300) });
}
