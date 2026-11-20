import { supabase } from './supabase';

// Printed reports: the organization's name and logo, a title, the date printed, page numbers, and column headings
// repeated on every page. "Save as PDF" in the print dialog makes the PDF.

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export interface ReportColumn { key: string; label: string; align?: 'left' | 'right' }
export interface ReportOptions {
  subtitle?: string;
  landscape?: boolean;
  /** Label and value pairs shown above the table. */
  summary?: [string, string][];
  /** Extra tables (like a breakdown) printed before the main one. */
  before?: { title: string; columns: ReportColumn[]; rows: Record<string, unknown>[] }[];
}

async function org() {
  const { data: id } = await supabase.rpc('current_org_id');
  const { data } = await supabase.from('organizations').select('name, logo_url').eq('id', id).maybeSingle();
  return (data ?? { name: '' }) as { name: string; logo_url?: string | null };
}

const table = (columns: ReportColumn[], rows: Record<string, unknown>[]) => `
  <table><thead><tr>${columns.map(c => `<th class="${c.align === 'right' ? 'r' : ''}">${esc(c.label)}</th>`).join('')}</tr></thead>
  <tbody>${rows.map(r => `<tr>${columns.map(c => `<td class="${c.align === 'right' ? 'r' : ''}">${esc(r[c.key])}</td>`).join('')}</tr>`).join('')}</tbody></table>`;

export async function printReport(title: string, columns: ReportColumn[], rows: Record<string, unknown>[], o: ReportOptions = {}) {
  const w = window.open('', '_blank');
  if (!w) throw new Error('The browser blocked the print window. Allow pop-ups for this site and try again.');
  const g = await org();
  const printed = new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
    @page { size: letter ${o.landscape ? 'landscape' : 'portrait'}; margin: 0.5in 0.45in 0.6in;
            @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 9px Arial, sans-serif; color: #555; }
            @bottom-left { content: "${esc(g.name)} · printed ${esc(printed)}"; font: 9px Arial, sans-serif; color: #555; } }
    body { font: 10.5px/1.35 Arial, Helvetica, sans-serif; color: #111; margin: 0; }
    header { display: flex; align-items: center; gap: 12px; border-bottom: 2px solid #111; padding-bottom: 8px; margin-bottom: 10px; }
    header img { max-height: 40px; max-width: 140px; }
    header h1 { font-size: 16px; margin: 0; }
    header .sub { color: #444; }
    header .meta { margin-left: auto; text-align: right; color: #444; }
    .summary { display: flex; flex-wrap: wrap; gap: 6px 22px; margin: 6px 0 12px; }
    .summary b { display: block; font-size: 13px; }
    h2 { font-size: 12px; margin: 14px 0 4px; }
    table { width: 100%; border-collapse: collapse; }
    thead { display: table-header-group; }
    tr { page-break-inside: avoid; }
    th { text-align: left; border-bottom: 1.5px solid #111; padding: 4px 5px; font-size: 10px; }
    td { padding: 3px 5px; border-bottom: 1px solid #ddd; vertical-align: top; }
    tbody tr:nth-child(even) td { background: #f4f4f4; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .r { text-align: right; white-space: nowrap; }
  </style></head><body>
    <header>${g.logo_url ? `<img src="${esc(g.logo_url)}" alt="">` : ''}<div><h1>${esc(title)}</h1><div class="sub">${esc(g.name)}${o.subtitle ? ` · ${esc(o.subtitle)}` : ''}</div></div>
      <div class="meta">Printed ${esc(printed)}<br>${rows.length.toLocaleString()} row${rows.length === 1 ? '' : 's'}</div></header>
    ${o.summary?.length ? `<div class="summary">${o.summary.map(([k, v]) => `<div>${esc(k)}<b>${esc(v)}</b></div>`).join('')}</div>` : ''}
    ${(o.before ?? []).map(b => `<h2>${esc(b.title)}</h2>${table(b.columns, b.rows)}`).join('')}
    ${o.before?.length ? '<h2>Details</h2>' : ''}${table(columns, rows)}
  </body></html>`);
  w.document.close();
  setTimeout(() => { try { w.focus(); w.print(); } catch { /* closed */ } }, 600);
}
