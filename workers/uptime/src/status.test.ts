import { describe, expect, it } from 'vitest';
import { HISTORY_DAYS, apply, overall, runCheck, uptime, type Result } from './status';
import { page } from './page';

const t = (iso: string) => new Date(iso);
const r = (name: string, up: boolean): Result => ({ name, up, ms: 120, detail: up ? 'HTTP 200' : 'HTTP 503: down' });

describe('uptime bookkeeping', () => {
  it('counts checks per day and opens and closes incidents', () => {
    let s = apply(null, {}, [], [r('App', true), r('Database', true)], t('2026-11-09T10:00:00Z'));
    expect(s.changed).toEqual([]);
    expect(overall(s.current)).toBe('operational');

    s = apply(s.current, s.history, s.incidents, [r('App', true), r('Database', false)], t('2026-11-09T10:05:00Z'));
    expect(s.changed).toEqual([{ name: 'Database', up: false, detail: 'HTTP 503: down' }]);
    expect(s.incidents[0]).toMatchObject({ component: 'Database', ended: null });
    expect(s.current.components.Database.since).toBe('2026-11-09T10:05:00.000Z');
    expect(s.current.components.App.since).toBe('2026-11-09T10:00:00.000Z');
    expect(overall(s.current)).toBe('partial');

    s = apply(s.current, s.history, s.incidents, [r('App', true), r('Database', true)], t('2026-11-09T10:10:00Z'));
    expect(s.changed.map(c => c.up)).toEqual([true]);
    expect(s.incidents[0].ended).toBe('2026-11-09T10:10:00.000Z');
    expect(s.history['2026-11-09']).toEqual({ App: [3, 3], Database: [2, 3] });
    expect(uptime(s.history, 'Database', 7, t('2026-11-09T12:00:00Z'))).toBeCloseTo(2 / 3);
    expect(uptime(s.history, 'Nothing', 7, t('2026-11-09T12:00:00Z'))).toBeNull();
  });

  it('keeps 90 days of history', () => {
    const old = { '2026-07-01': { App: [1, 1] as [number, number] }, '2026-11-01': { App: [1, 1] as [number, number] } };
    const s = apply(null, old, [], [r('App', true)], t('2026-11-09T00:00:00Z'));
    expect(Object.keys(s.history).sort()).toEqual(['2026-11-01', '2026-11-09']);
    expect(HISTORY_DAYS).toBe(90);
  });

  it('reports a timeout or a wrong answer as down', async () => {
    const ok = await runCheck({ name: 'A', url: 'https://x' }, (async () => new Response('fine')) as any);
    expect(ok).toMatchObject({ up: true, detail: 'HTTP 200' });
    const bad = await runCheck({ name: 'B', url: 'https://x', expect: (_s, b) => b.includes('"status":"ok"') },
      (async () => new Response('{"status":"degraded"}', { status: 200 })) as any);
    expect(bad.up).toBe(false);
    const slow = await runCheck({ name: 'C', url: 'https://x' }, ((_u: string, init: RequestInit) => new Promise((_res, rej) => {
      init.signal!.addEventListener('abort', () => rej(Object.assign(new Error('timed out'), { name: 'TimeoutError' })));
    })) as any, 20);
    expect(slow).toMatchObject({ up: false, detail: 'No answer within 0.02 seconds' });
  });

  it('renders the page without letting text through as HTML', () => {
    const s = apply(null, {}, [], [{ name: '<script>', up: false, ms: 1, detail: '<b>x</b>' }], t('2026-11-09T10:00:00Z'));
    const html = page('Status', s.current, s.history, s.incidents, t('2026-11-09T10:01:00Z'));
    expect(html).toContain('Systems are down');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
});
