// The bookkeeping behind the status page, kept free of Cloudflare APIs so it can be tested.

export interface Check { name: string; url: string; headers?: Record<string, string>; expect?: (status: number, body: string) => boolean }
export interface Result { name: string; up: boolean; ms: number; detail: string }
export interface Component { up: boolean; ms: number; since: string; detail: string }
export interface Current { checked_at: string; components: Record<string, Component> }
/** Per day (YYYY-MM-DD, UTC), per component: [checks up, checks made]. Kept for 90 days. */
export type History = Record<string, Record<string, [number, number]>>;
export interface Incident { component: string; started: string; ended: string | null; detail: string }

export const HISTORY_DAYS = 90;
export const MAX_INCIDENTS = 50;

export function apply(prev: Current | null, history: History, incidents: Incident[], results: Result[], now: Date) {
  const at = now.toISOString();
  const day = at.slice(0, 10);
  const components: Record<string, Component> = {};
  const changed: { name: string; up: boolean; detail: string }[] = [];
  const nextHistory: History = { ...history, [day]: { ...(history[day] ?? {}) } };
  let nextIncidents = incidents.slice();

  for (const r of results) {
    const before = prev?.components[r.name];
    const flipped = !before || before.up !== r.up;
    components[r.name] = { up: r.up, ms: r.ms, detail: r.detail, since: flipped ? at : before.since };
    const [up, total] = nextHistory[day][r.name] ?? [0, 0];
    nextHistory[day][r.name] = [up + (r.up ? 1 : 0), total + 1];
    if (!flipped) continue;
    if (!r.up) {
      nextIncidents.unshift({ component: r.name, started: at, ended: null, detail: r.detail });
      changed.push({ name: r.name, up: false, detail: r.detail });
    } else if (before) {
      nextIncidents = nextIncidents.map(i => (i.component === r.name && i.ended === null ? { ...i, ended: at } : i));
      changed.push({ name: r.name, up: true, detail: r.detail });
    }
  }

  const cutoff = new Date(now.getTime() - (HISTORY_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
  for (const d of Object.keys(nextHistory)) if (d < cutoff) delete nextHistory[d];

  return {
    current: { checked_at: at, components } as Current,
    history: nextHistory,
    incidents: nextIncidents.slice(0, MAX_INCIDENTS),
    changed,
  };
}

/** Share of checks that were up over the last `days` days, or null with no checks. */
export function uptime(history: History, name: string, days: number, now: Date): number | null {
  let up = 0, total = 0;
  for (let i = 0; i < days; i++) {
    const d = new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    const h = history[d]?.[name];
    if (h) { up += h[0]; total += h[1]; }
  }
  return total ? up / total : null;
}

export function overall(current: Current | null): 'operational' | 'partial' | 'major' | 'unknown' {
  const list = Object.values(current?.components ?? {});
  if (!list.length) return 'unknown';
  const down = list.filter(c => !c.up).length;
  return down === 0 ? 'operational' : down === list.length ? 'major' : 'partial';
}

export async function runCheck(c: Check, fetcher: typeof fetch = fetch, timeoutMs = 10_000): Promise<Result> {
  const started = Date.now();
  try {
    const res = await fetcher(c.url, { headers: { 'User-Agent': 'oizer-uptime', ...(c.headers ?? {}) }, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
    const body = await res.text();
    const ok = c.expect ? c.expect(res.status, body) : res.status >= 200 && res.status < 300;
    return { name: c.name, up: ok, ms: Date.now() - started, detail: ok ? `HTTP ${res.status}` : `HTTP ${res.status}: ${body.slice(0, 120)}` };
  } catch (e) {
    const err = e as Error;
    return { name: c.name, up: false, ms: Date.now() - started, detail: err.name === 'TimeoutError' ? `No answer within ${timeoutMs / 1000} seconds` : err.message };
  }
}
