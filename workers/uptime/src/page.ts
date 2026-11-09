import { HISTORY_DAYS, overall, uptime, type Current, type History, type Incident } from './status';

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const pct = (v: number | null) => (v === null ? '—' : `${(Math.floor(v * 10000) / 100).toFixed(2)}%`);
const when = (iso: string) => new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' }) + ' ET';

const HEADLINE = {
  operational: 'All systems working', partial: 'Some systems are down', major: 'Systems are down', unknown: 'No checks yet',
};

export function page(title: string, current: Current | null, history: History, incidents: Incident[], now: Date) {
  const state = overall(current);
  const rows = Object.entries(current?.components ?? {}).map(([name, c]) => {
    const bars = Array.from({ length: HISTORY_DAYS }, (_, i) => {
      const d = new Date(now.getTime() - (HISTORY_DAYS - 1 - i) * 86_400_000).toISOString().slice(0, 10);
      const h = history[d]?.[name];
      const share = h ? h[0] / h[1] : null;
      const cls = share === null ? 'none' : share >= 0.999 ? 'up' : share >= 0.95 ? 'some' : 'down';
      return `<i class="${cls}" title="${d}: ${share === null ? 'no checks' : pct(share)}"></i>`;
    }).join('');
    return `<li>
      <div class="row"><span class="dot ${c.up ? 'up' : 'down'}"></span><b>${esc(name)}</b>
        <span class="muted">${c.up ? `Working · ${c.ms} ms` : `Down since ${when(c.since)}`}</span>
        <span class="pct" title="Last 90 days">${pct(uptime(history, name, HISTORY_DAYS, now))}</span></div>
      <div class="bars" aria-label="Daily uptime, last 90 days">${bars}</div>
    </li>`;
  }).join('');
  const recent = incidents.slice(0, 10).map(i => `<li><b>${esc(i.component)}</b> · ${when(i.started)} – ${i.ended ? when(i.ended) : '<span class="down-text">ongoing</span>'}<div class="muted">${esc(i.detail)}</div></li>`).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><meta http-equiv="refresh" content="300"><title>${esc(title)}</title>
<style>
:root{--bg:#f7f7f8;--card:#fff;--text:#1d1d1f;--muted:#6b6b70;--line:#e4e4e7;--up:#1f9d55;--some:#d69e2e;--down:#d64545;--none:#d4d4d8}
@media (prefers-color-scheme:dark){:root{--bg:#111113;--card:#1b1b1e;--text:#ededf0;--muted:#a0a0a8;--line:#2c2c31;--none:#3a3a40}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:760px;margin:0 auto;padding:32px 16px}h1{font-size:22px;margin:0 0 16px}h2{font-size:16px;margin:28px 0 8px}
.banner{padding:16px 18px;border-radius:10px;color:#fff;font-weight:600;background:var(--up)}.banner.partial{background:var(--some)}.banner.major{background:var(--down)}.banner.unknown{background:var(--muted)}
ul{list-style:none;margin:0;padding:0;background:var(--card);border:1px solid var(--line);border-radius:10px}li{padding:14px 16px;border-top:1px solid var(--line)}li:first-child{border-top:0}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.pct{margin-left:auto;font-variant-numeric:tabular-nums}.muted{color:var(--muted);font-size:13px}
.dot{width:10px;height:10px;border-radius:50%}.dot.up{background:var(--up)}.dot.down{background:var(--down)}.down-text{color:var(--down)}
.bars{display:flex;gap:2px;margin-top:8px;height:24px}.bars i{flex:1;border-radius:2px;background:var(--none)}.bars i.up{background:var(--up)}.bars i.some{background:var(--some)}.bars i.down{background:var(--down)}
footer{margin-top:24px;color:var(--muted);font-size:13px}
</style></head><body><main>
<h1>${esc(title)}</h1>
<div class="banner ${state}">${HEADLINE[state]}</div>
<h2>Systems</h2><ul>${rows || '<li class="muted">The first check runs within 5 minutes.</li>'}</ul>
<h2>Recent incidents</h2><ul>${recent || '<li class="muted">None recorded.</li>'}</ul>
<footer>${current ? `Checked ${when(current.checked_at)} · ` : ''}Checked every 5 minutes from Cloudflare, independently of the app.</footer>
</main></body></html>`;
}
