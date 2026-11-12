import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Moshe Henig, 2026-11-12: users were signed out every 30 minutes even while working. The server ends a session not
// renewed for 30 minutes, and the browser only renewed its 60-minute token when it ran out.
function fakeStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k), clear: () => m.clear() };
}
const MIN = 60 * 1000;

describe('idle sign-out', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-12T15:00:00Z'));
    vi.stubGlobal('localStorage', fakeStorage());
    vi.stubGlobal('sessionStorage', fakeStorage());
    vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {}, setInterval: (f: () => void, ms: number) => setInterval(f, ms), clearInterval: (id: number) => clearInterval(id) });
    vi.resetModules();
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('keeps someone who is working signed in for hours, renewing the session at least every 10 minutes', async () => {
    const idle = await import('./idle');
    const onIdle = vi.fn();
    const renew = vi.fn(async () => {});
    const stop = idle.watchIdle(onIdle, idle.IDLE_LIMIT_MS, renew);
    for (let m = 0; m < 180; m += 5) {          // three hours, something done every 5 minutes
      vi.advanceTimersByTime(5 * MIN);
      idle.noteActivity();
    }
    expect(onIdle).not.toHaveBeenCalled();
    expect(renew.mock.calls.length).toBeGreaterThanOrEqual(17);   // about every 10 minutes: never 30 without one
    stop();
  });

  it('signs out only after 30 minutes with no activity, and stops renewing once idle', async () => {
    const idle = await import('./idle');
    const onIdle = vi.fn();
    const renew = vi.fn(async () => {});
    idle.watchIdle(onIdle, idle.IDLE_LIMIT_MS, renew);
    vi.advanceTimersByTime(29 * MIN);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2 * MIN);
    expect(onIdle).toHaveBeenCalled();
    expect(renew.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('activity resets the clock', async () => {
    const idle = await import('./idle');
    const onIdle = vi.fn();
    idle.watchIdle(onIdle, idle.IDLE_LIMIT_MS, async () => {});
    vi.advanceTimersByTime(25 * MIN);
    idle.noteActivity();
    vi.advanceTimersByTime(25 * MIN);   // 50 minutes since sign-in, 25 since the last activity
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(6 * MIN);
    expect(onIdle).toHaveBeenCalled();
  });

  it("uses the organization's limit, and keeps the session renewed while inside it", async () => {
    const idle = await import('./idle');
    expect(idle.idleLimitMs(60)).toBe(60 * MIN);
    expect(idle.idleLimitMs(null)).toBe(30 * MIN);
    expect(idle.idleLimitMs(2)).toBe(30 * MIN);       // out of range: the default
    const onIdle = vi.fn();
    const renew = vi.fn(async () => {});
    idle.watchIdle(onIdle, idle.idleLimitMs(60), renew);
    vi.advanceTimersByTime(45 * MIN);                 // idle 45 minutes: still signed in, and renewed past 30
    expect(onIdle).not.toHaveBeenCalled();
    expect(renew.mock.calls.length).toBeGreaterThanOrEqual(4);
    vi.advanceTimersByTime(16 * MIN);
    expect(onIdle).toHaveBeenCalled();
  });

  it("counts the app's requests as activity, but not the ones it makes by itself on a timer", async () => {
    const { countsAsActivity } = await import('./idle');
    const base = 'https://x.supabase.co';
    expect(countsAsActivity(`${base}/rest/v1/campaign_summary?select=*`)).toBe(true);
    expect(countsAsActivity(`${base}/rest/v1/rpc/assign_unattributed`)).toBe(true);
    expect(countsAsActivity(`${base}/functions/v1/api`)).toBe(true);
    for (const bg of ['/rest/v1/rpc/unread_message_count', '/rest/v1/rpc/my_threads', '/rest/v1/rpc/thread_history', '/rest/v1/announcements?select=*', '/functions/v1/domains', '/auth/v1/token?grant_type=refresh_token']) {
      expect(countsAsActivity(base + bg)).toBe(false);
    }
  });

  it('accepts idle limits from 5 to 720 minutes on the settings screen', async () => {
    const { parseIdleMinutes } = await import('./idle');
    expect(parseIdleMinutes('30')).toBe(30);
    expect(parseIdleMinutes('720')).toBe(720);
    for (const bad of ['', '4', '721', '10.5', 'x']) expect(typeof parseIdleMinutes(bad)).toBe('string');
  });
});
