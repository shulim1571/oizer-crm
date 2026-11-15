import { useEffect, useRef } from 'react';
import { requestOrgId, supabase } from './supabase';

/*
 * Live refresh (Moshe Henig, 2026-11-15): open screens update on their own when data changes.
 *
 * One Realtime connection per browser tab listens to `live_pings`: tiny rows (organization, topic, time) that the
 * database adds once per write statement. No donation data comes over it; a screen that hears its topic quietly
 * reloads its own data the usual way. Kept light:
 * - pings close together are gathered into one reload (1.5 seconds after the last one);
 * - a hidden tab reloads nothing, and catches up once when it is shown again;
 * - if Realtime can't connect, screens fall back to a quiet reload every 2 minutes while visible, and every
 *   5 minutes anyway as a safety net.
 */
export type LiveTopic = 'gifts' | 'payouts' | 'transfers' | 'pledges' | 'campaigns';
export const ALL_TOPICS: LiveTopic[] = ['gifts', 'payouts', 'transfers', 'pledges', 'campaigns'];

export const LIVE_TIMING = { gatherMs: 1500, fallbackMs: 120_000, safetyMs: 300_000 };

type Listener = (topic: LiveTopic) => void;
const listeners = new Set<Listener>();
let channel: ReturnType<typeof supabase.channel> | null = null;
let channelOrg: string | null = null;
let connected = false;

export const liveConnected = () => connected;

function connect() {
  const org = requestOrgId();
  if (channel && channelOrg === org) return;
  disconnect();
  if (!org) return;
  channelOrg = org;
  channel = supabase.channel(`live:${org}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'live_pings', filter: `org_id=eq.${org}` },
      payload => { const t = (payload.new as { topic?: LiveTopic }).topic; if (t) listeners.forEach(l => l(t)); })
    .subscribe(status => { connected = status === 'SUBSCRIBED'; });
}
function disconnect() {
  if (channel) void supabase.removeChannel(channel);
  channel = null;
  channelOrg = null;
  connected = false;
}

/** Calls `refresh` when any of `topics` changes in the database (see above). `refresh` should be a quiet reload. */
export function useLiveRefresh(topics: LiveTopic[], refresh: () => void, enabled = true) {
  const latest = useRef(refresh);
  latest.current = refresh;
  const key = topics.join(',');
  useEffect(() => {
    if (!enabled) return;
    const wanted = new Set(key.split(',') as LiveTopic[]);
    const visible = () => document.visibilityState === 'visible';
    let timer = 0;
    let missed = false;
    let lastRun = Date.now();
    const run = () => { lastRun = Date.now(); missed = false; latest.current(); };
    const listener: Listener = topic => {
      if (!wanted.has(topic)) return;
      if (!visible()) { missed = true; return; }
      window.clearTimeout(timer);
      timer = window.setTimeout(run, LIVE_TIMING.gatherMs);
    };
    listeners.add(listener);
    connect();
    const onShow = () => { if (visible() && (missed || !connected)) run(); };
    const poll = window.setInterval(() => {
      connect();   // also follows an organization switch
      if (!visible()) return;
      const since = Date.now() - lastRun;
      if ((!connected && since >= LIVE_TIMING.fallbackMs) || since >= LIVE_TIMING.safetyMs) run();
    }, 15_000);
    document.addEventListener('visibilitychange', onShow);
    return () => {
      listeners.delete(listener);
      window.clearTimeout(timer);
      window.clearInterval(poll);
      document.removeEventListener('visibilitychange', onShow);
      if (listeners.size === 0) disconnect();
    };
  }, [key, enabled]);
}
