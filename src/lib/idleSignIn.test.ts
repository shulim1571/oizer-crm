import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Shulim, 2026-11-11: after the 30-minute idle sign-out, signing in again showed "Please wait…" and dropped back to
// the sign-in page: the old activity time was still stored, so the idle check signed the new session straight out.
function fakeStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k), clear: () => m.clear() };
}

describe('signing in again after an idle sign-out', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-11T15:00:00Z'));
    vi.stubGlobal('localStorage', fakeStorage());
    vi.stubGlobal('sessionStorage', fakeStorage());
    vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {}, setInterval: (f: () => void, ms: number) => setInterval(f, ms), clearInterval: (id: number) => clearInterval(id) });
    vi.resetModules();
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('reproduces the bug: a stale activity time signs a new session out at once', async () => {
    const idle = await import('./idle');
    idle.markActivity(Date.now() - 2 * 60 * 60 * 1000);
    const onIdle = vi.fn();
    idle.watchIdle(onIdle);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('a fresh sign-in restarts the clock and clears the notice, so the new session stays signed in', async () => {
    const idle = await import('./idle');
    idle.markActivity(Date.now() - 2 * 60 * 60 * 1000);       // left over from before the idle sign-out
    sessionStorage.setItem('signed-out-idle', '1');
    idle.startFreshSession();                                   // what sign-in now does first
    expect(sessionStorage.getItem('signed-out-idle')).toBeNull();
    const onIdle = vi.fn();
    const stop = idle.watchIdle(onIdle);
    vi.advanceTimersByTime(29 * 60 * 1000);
    expect(onIdle).not.toHaveBeenCalled();
    // Idle for more than 30 minutes still signs out.
    vi.advanceTimersByTime(2 * 60 * 1000);
    expect(onIdle).toHaveBeenCalled();
    stop();
  });

  it('an idle sign-out clears the stored time, so it can’t count against the next session', async () => {
    const idle = await import('./idle');
    idle.markActivity(Date.now() - 31 * 60 * 1000);
    idle.clearActivity();
    expect(idle.readLastActivity()).toBeNull();
    const onIdle = vi.fn();
    idle.watchIdle(onIdle);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it('is wired in: sign-in restarts the clock before the session is set, idle sign-out clears it, and failures show', () => {
    const sb = readFileSync('src/lib/supabase.ts', 'utf8');
    expect(sb.indexOf('startFreshSession();')).toBeGreaterThan(-1);
    expect(sb.indexOf('startFreshSession();')).toBeLessThan(sb.indexOf('return supabase.auth.setSession(data.session);'));
    const auth = readFileSync('src/lib/auth.tsx', 'utf8');
    expect(auth).toContain("if (event === 'SIGNED_IN') startFreshSession();");
    expect(auth).toMatch(/watchIdle\(\(\) => \{\s*clearActivity\(\);/);
    const login = readFileSync('src/pages/Login.tsx', 'utf8');
    expect(login).toContain('setIdleNote(false);');
    expect(login).toMatch(/Your password was accepted, but Donor Base couldn’t open your session/);
  });
});
