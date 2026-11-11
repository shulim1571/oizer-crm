import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabase';

/**
 * Two-step verification (TOTP) state for the signed-in person (Shulim, 2026-11-11). `verified` means this session
 * passed a code (aal2); `enrolled` means they have an authenticator set up. Bank and reconciliation data need
 * `verified`; the database enforces the same.
 */
export interface MfaState { loading: boolean; verified: boolean; enrolled: boolean; factorId: string | null }

export async function readMfa(): Promise<Omit<MfaState, 'loading'>> {
  const [{ data: aal }, { data: factors }] = await Promise.all([
    supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
    supabase.auth.mfa.listFactors(),
  ]);
  const totp = (factors?.totp ?? []).find(f => f.status === 'verified') ?? null;
  return { verified: aal?.currentLevel === 'aal2', enrolled: !!totp, factorId: totp?.id ?? null };
}

export function useMfa() {
  const [state, setState] = useState<MfaState>({ loading: true, verified: false, enrolled: false, factorId: null });
  const reload = useCallback(async () => {
    try { setState({ loading: false, ...(await readMfa()) }); } catch { setState(s => ({ ...s, loading: false })); }
  }, []);
  useEffect(() => {
    void reload();
    const { data: sub } = supabase.auth.onAuthStateChange(() => { setTimeout(() => void reload(), 0); });
    return () => sub.subscription.unsubscribe();
  }, [reload]);
  return { ...state, reload };
}

/** A 6-digit code from the authenticator app, for this session. */
export async function verifyCode(factorId: string, code: string): Promise<string | null> {
  const clean = code.replace(/\D/g, '');
  if (clean.length !== 6) return 'Enter the 6-digit code from your authenticator app.';
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: clean });
  return error ? (/invalid|expired/i.test(error.message) ? 'That code didn’t work. Check the time on your phone and try the newest code.' : error.message) : null;
}
