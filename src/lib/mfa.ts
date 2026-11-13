import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from './supabase';
import { isRepeatAuthEvent, MFA_EVENTS } from './authEvents';
import { phoneCodeProblem } from './phoneCodeResult';

/**
 * Two-step verification (TOTP) state for the signed-in person (Shulim, 2026-11-11). `verified` means this session
 * passed a code (aal2); `enrolled` means they have an authenticator set up. Bank and reconciliation data need
 * `verified`; the database enforces the same.
 */
export interface MfaState {
  loading: boolean;
  /** This session passed two-step verification: an authenticator code (aal2) or a phone code the database recorded for it. */
  verified: boolean;
  /** Any second step set up (authenticator app or phone). */
  enrolled: boolean;
  /** The verified authenticator app, if any. */
  factorId: string | null;
  /** A verified phone for text or call codes, if any. */
  phone: { masked: string; channel: 'sms' | 'call' } | null;
}

export async function readMfa(): Promise<Omit<MfaState, 'loading'>> {
  const [{ data: aal, error: e1 }, { data: factors, error: e2 }, { data: ph, error: e3 }] = await Promise.all([
    supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
    supabase.auth.mfa.listFactors(),
    supabase.rpc('mfa_phone_status'),
  ]);
  // A check that failed (for one, a token still being renewed) says nothing; it must not read as "not verified".
  const failed = e1 ?? e2 ?? e3;
  if (failed) throw new Error(failed.message);
  const totp = (factors?.totp ?? []).find(f => f.status === 'verified') ?? null;
  const p = ((ph ?? []) as { phone_masked: string | null; channel: 'sms' | 'call'; verified: boolean; session_verified: boolean }[])[0];
  const phone = p?.verified && p.phone_masked ? { masked: p.phone_masked, channel: p.channel } : null;
  return {
    verified: aal?.currentLevel === 'aal2' || !!p?.session_verified,
    enrolled: !!totp || !!phone,
    factorId: totp?.id ?? null,
    phone,
  };
}

export function useMfa() {
  const [state, setState] = useState<MfaState>({ loading: true, verified: false, enrolled: false, factorId: null, phone: null });
  const reload = useCallback(async () => {
    try { setState({ loading: false, ...(await readMfa()) }); } catch { setState(s => ({ ...s, loading: false })); }
  }, []);
  const userId = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    void reload();
    // Only events that can change verification; not the repeat SIGNED_IN Supabase sends when the tab regains focus.
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      const previous = userId.current ?? null;
      userId.current = s?.user?.id ?? null;
      if (isRepeatAuthEvent(event, previous, userId.current) || !MFA_EVENTS.has(event)) return;
      // Signed out, or someone else signed in: nothing verified carries over to the next person.
      if (event === 'SIGNED_OUT' || (previous && previous !== userId.current)) {
        setState({ loading: false, verified: false, enrolled: false, factorId: null, phone: null });
      }
      if (event === 'SIGNED_OUT') return;
      setTimeout(() => void reload(), 0);
    });
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

/** Ask for a code by text or call. Returns the challenge to verify, or an error message. */
export async function sendPhoneCode(purpose: 'enroll' | 'signin', channel: 'sms' | 'call', phone?: string): Promise<{ challengeId: string; masked: string } | { error: string }> {
  const { data, error } = await supabase.functions.invoke('phone-code', { body: { purpose, channel, phone } });
  if (error) return { error: 'The code couldn’t be sent. Try again in a moment.' };
  if (data?.error) return { error: String(data.error) };
  return { challengeId: String(data.challenge_id), masked: String(data.phone_masked) };
}

/** Check a text or call code; the database records this session as verified when it's right. */
export async function verifyPhoneCode(challengeId: string, code: string): Promise<string | null> {
  const clean = code.replace(/\D/g, '');
  if (clean.length !== 6) return 'Enter the 6-digit code.';
  const { data, error } = await supabase.rpc('mfa_phone_verify', { p_challenge: challengeId, p_code: clean });
  if (error) return error.message;
  return phoneCodeProblem(data);
}
