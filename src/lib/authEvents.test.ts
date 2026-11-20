import { describe, expect, it } from 'vitest';
import { isRepeatAuthEvent, MFA_EVENTS } from './authEvents';

describe('auth events on returning to the tab', () => {
  it('ignores the SIGNED_IN Supabase sends on refocus, and token renewals, for the same person', () => {
    expect(isRepeatAuthEvent('SIGNED_IN', 'u1', 'u1')).toBe(true);
    expect(isRepeatAuthEvent('TOKEN_REFRESHED', 'u1', 'u1')).toBe(true);
    expect(isRepeatAuthEvent('INITIAL_SESSION', 'u1', 'u1')).toBe(true);
  });
  it('still handles a real sign-in, sign-out, a different person and profile changes', () => {
    expect(isRepeatAuthEvent('SIGNED_IN', null, 'u1')).toBe(false);
    expect(isRepeatAuthEvent('SIGNED_IN', 'u1', 'u2')).toBe(false);
    expect(isRepeatAuthEvent('SIGNED_OUT', 'u1', null)).toBe(false);
    expect(isRepeatAuthEvent('USER_UPDATED', 'u1', 'u1')).toBe(false);
    expect(isRepeatAuthEvent('PASSWORD_RECOVERY', 'u1', 'u1')).toBe(false);
    expect(isRepeatAuthEvent('MFA_CHALLENGE_VERIFIED', 'u1', 'u1')).toBe(false);
  });
  it('re-checks two-step verification only after events that can change it', () => {
    expect(MFA_EVENTS.has('TOKEN_REFRESHED')).toBe(false);
    expect(MFA_EVENTS.has('MFA_CHALLENGE_VERIFIED')).toBe(true);
  });
});
