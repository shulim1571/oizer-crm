// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Moshe Henig, 2026-11-15: open screens update on their own when data changes, light on load.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fake = vi.hoisted(() => ({
  handler: null as null | ((p: { new: { topic: string } }) => void),
  status: null as null | ((s: string) => void),
  filter: '', channels: 0, removed: 0,
}));
vi.mock('./supabase', () => ({
  requestOrgId: () => '00000000-0000-4000-8000-000000000001',
  supabase: {
    channel: () => {
      fake.channels++;
      const ch = {
        on: (_e: string, opts: { filter: string }, h: typeof fake.handler) => { fake.filter = opts.filter; fake.handler = h; return ch; },
        subscribe: (cb: (s: string) => void) => { fake.status = cb; return ch; },
      };
      return ch;
    },
    removeChannel: async () => { fake.removed++; },
  },
}));
import { ALL_TOPICS, LIVE_TIMING, useLiveRefresh, type LiveTopic } from './live';

function Screen({ topics, refresh }: { topics: LiveTopic[]; refresh: () => void }) { useLiveRefresh(topics, refresh); return null; }
const roots: { unmount(): void }[] = [];
function mount(topics: LiveTopic[]) {
  const refresh = vi.fn();
  const root = createRoot(document.createElement('div'));
  act(() => root.render(<Screen topics={topics} refresh={refresh} />));
  roots.push(root);
  return { refresh, root };
}
const ping = (topic: string) => act(() => fake.handler?.({ new: { topic } }));
let hidden = false;

describe('live refresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    hidden = false;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
    Object.assign(fake, { handler: null, status: null, filter: '', channels: 0, removed: 0 });
  });
  afterEach(() => { act(() => { while (roots.length) roots.pop()!.unmount(); }); vi.useRealTimers(); });

  it("listens only to this organization's pings, and gathers pings close together into one quiet reload", () => {
    const { refresh } = mount(['gifts']);
    act(() => fake.status?.('SUBSCRIBED'));
    expect(fake.filter).toBe('org_id=eq.00000000-0000-4000-8000-000000000001');
    ping('gifts'); ping('gifts'); ping('gifts');
    expect(refresh).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(LIVE_TIMING.gatherMs); });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("ignores topics the screen doesn't show", () => {
    const { refresh } = mount(['payouts']);
    act(() => fake.status?.('SUBSCRIBED'));
    ping('gifts');
    act(() => { vi.advanceTimersByTime(5000); });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('reloads nothing while the tab is hidden, and catches up once when it is shown', () => {
    const { refresh } = mount(ALL_TOPICS);
    act(() => fake.status?.('SUBSCRIBED'));
    hidden = true;
    ping('gifts'); ping('payouts');
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(refresh).not.toHaveBeenCalled();
    hidden = false;
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('falls back to a reload every 2 minutes when the live connection is down, and a 5-minute safety net when up', () => {
    const down = mount(['gifts']);
    act(() => fake.status?.('CHANNEL_ERROR'));
    act(() => { vi.advanceTimersByTime(LIVE_TIMING.fallbackMs + 15_000); });
    expect(down.refresh).toHaveBeenCalledTimes(1);
    act(() => fake.status?.('SUBSCRIBED'));
    act(() => { vi.advanceTimersByTime(LIVE_TIMING.fallbackMs); });
    expect(down.refresh).toHaveBeenCalledTimes(1);   // connected: no 2-minute polling
    act(() => { vi.advanceTimersByTime(LIVE_TIMING.safetyMs); });
    expect(down.refresh).toHaveBeenCalledTimes(2);
  });

  it('shares one connection per tab and closes it when the last screen goes', () => {
    const a = mount(['gifts']);
    mount(['payouts']);
    expect(fake.channels).toBe(1);
    act(() => a.root.unmount());
    expect(fake.removed).toBe(0);
    act(() => { while (roots.length) roots.pop()!.unmount(); });
    expect(fake.removed).toBe(1);
  });
});

describe('screens that update on their own', () => {
  const src = (f: string) => readFileSync(`src/${f}`, 'utf8');
  it('covers the dashboard, campaign balances, checks, payouts, transfers and transactions, with quiet reloads', () => {
    expect(src('pages/Dashboard.tsx')).toContain('useLiveRefresh(ALL_TOPICS, () => { void q.reload({ quiet: true });');
    expect(src('pages/Dashboard.tsx')).not.toContain('120_000');
    expect(src('pages/Campaigns.tsx')).toContain("useLiveRefresh(['gifts', 'payouts', 'transfers', 'pledges', 'campaigns'], () => void reload({ quiet: true }));");
    expect(src('pages/CampaignDetail.tsx')).toContain('useLiveRefresh(ALL_TOPICS, () => { void summary.reload({ quiet: true }); void rows.reload({ quiet: true }); });');
    expect(src('pages/Checks.tsx')).toContain("useLiveRefresh(['payouts'], () => void q.reload({ quiet: true }));");
    expect(src('pages/Payouts.tsx')).toContain("useLiveRefresh(['payouts'], () => void q.reload({ quiet: true }));");
    expect(src('pages/Transfers.tsx')).toContain("useLiveRefresh(['transfers'], () => void q.reload({ quiet: true }));");
    expect(src('pages/SimplePages.tsx')).toMatch(/table="expenses"\n\s*live=\{\['payouts'\]\}/);
    expect(src('pages/Donations.tsx')).toContain("useLiveRefresh(['gifts'], () => { void reload({ quiet: true }); void totals.reload({ quiet: true }); });");
  });
});
