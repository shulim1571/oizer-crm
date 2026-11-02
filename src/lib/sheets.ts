import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

export interface SheetColumn { key: string; label: string }
type Cell = string | number | null | undefined;

const xml = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
  // Characters Excel refuses inside XML.
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

const colName = (i: number) => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

/** A one-sheet .xlsx file. Numbers stay numbers so Excel can add them up. */
export function toXlsx(rows: Record<string, Cell>[], cols: SheetColumn[], sheetName = 'Sheet1'): Uint8Array {
  const cell = (v: Cell, ref: string, bold = false) => {
    if (v == null || v === '') return '';
    if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${bold ? ' s="1"' : ''}><v>${v}</v></c>`;
    return `<c r="${ref}" t="inlineStr"${bold ? ' s="1"' : ''}><is><t xml:space="preserve">${xml(String(v))}</t></is></c>`;
  };
  const header = `<row r="1">${cols.map((c, i) => cell(c.label, `${colName(i)}1`, true)).join('')}</row>`;
  const body = rows.map((r, n) => `<row r="${n + 2}">${cols.map((c, i) => cell(r[c.key], `${colName(i)}${n + 2}`)).join('')}</row>`).join('');
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xml(sheetName.slice(0, 31).replace(/[\\/?*[\]:]/g, ' '))}" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'),
    'xl/styles.xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf/><xf fontId="1" applyFont="1"/></cellXfs></styleSheet>'),
    'xl/worksheets/sheet1.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>${header}${body}</sheetData></worksheet>`),
  };
  return zipSync(files);
}

/** Turns money-looking text into a number for the spreadsheet; everything else stays as it is. */
export const sheetValue = (v: unknown): Cell => {
  if (v == null) return '';
  if (typeof v === 'number') return v;
  const s = String(v);
  return /^-?\$?\d{1,3}(,\d{3})*(\.\d+)?$|^-?\$?\d+(\.\d+)?$/.test(s) ? Number(s.replace(/[$,]/g, '')) : s;
};

export function downloadBytes(name: string, bytes: Uint8Array, type: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// ---------------------------------------------------------------------------
// Reading uploads: CSV, or the first sheet of an .xlsx file
// ---------------------------------------------------------------------------
export function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field); out.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); out.push(row); }
  return out.filter(r => r.some(c => c.trim() !== ''));
}

/** Excel stores dates as days since 1899-12-30. */
const excelDate = (n: number) => new Date(Date.UTC(1899, 11, 30) + Math.round(n * 86400000)).toISOString().slice(0, 10);

export function parseXlsx(bytes: Uint8Array): string[][] {
  const files = unzipSync(bytes);
  const read = (path: string) => (files[path] ? new DOMParser().parseFromString(strFromU8(files[path]), 'application/xml') : null);
  const shared = [...(read('xl/sharedStrings.xml')?.getElementsByTagName('si') ?? [])].map(si => [...si.getElementsByTagName('t')].map(t => t.textContent ?? '').join(''));
  // Which number formats are dates, so a date cell comes out as a date.
  const styles = read('xl/styles.xml');
  const customDate = new Set([...(styles?.getElementsByTagName('numFmt') ?? [])].filter(f => /[dmy]/i.test(f.getAttribute('formatCode') ?? '') && !/\[h|h:|s/i.test(f.getAttribute('formatCode') ?? '')).map(f => f.getAttribute('numFmtId')));
  const xfs = [...(styles?.getElementsByTagName('cellXfs')[0]?.getElementsByTagName('xf') ?? [])].map(x => x.getAttribute('numFmtId') ?? '0');
  const isDate = (s: string | null) => { const id = xfs[Number(s ?? 0)]; return !!id && ((Number(id) >= 14 && Number(id) <= 22) || customDate.has(id)); };
  const rels = read('xl/_rels/workbook.xml.rels');
  const firstSheet = read('xl/workbook.xml')?.getElementsByTagName('sheet')[0];
  const rid = firstSheet?.getAttribute('r:id');
  const target = [...(rels?.getElementsByTagName('Relationship') ?? [])].find(r => r.getAttribute('Id') === rid)?.getAttribute('Target') ?? 'worksheets/sheet1.xml';
  const sheet = read(`xl/${target.replace(/^\/?xl\//, '')}`);
  if (!sheet) throw new Error('That file has no sheet to read');
  const out: string[][] = [];
  for (const row of [...sheet.getElementsByTagName('row')]) {
    const cells: string[] = [];
    for (const c of [...row.getElementsByTagName('c')]) {
      const ref = c.getAttribute('r') ?? '';
      const col = ref.replace(/\d+/g, '').split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
      const t = c.getAttribute('t');
      const v = c.getElementsByTagName('v')[0]?.textContent ?? '';
      let value = t === 's' ? shared[Number(v)] ?? '' : t === 'inlineStr' ? [...c.getElementsByTagName('t')].map(x => x.textContent ?? '').join('') : v;
      if (!t && v !== '' && isDate(c.getAttribute('s'))) value = excelDate(Number(v));
      cells[col < 0 ? cells.length : col] = value;
    }
    out.push(Array.from(cells, x => x ?? ''));
  }
  return out.filter(r => r.some(c => String(c).trim() !== ''));
}

/** "First Name" → first_name, so headers match however they're written. */
export const headerKey = (h: string) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/** Rows of objects keyed by header, from a CSV or .xlsx file. */
export async function readSheet(file: File): Promise<Record<string, string>[]> {
  const grid = /\.xlsx$/i.test(file.name) ? parseXlsx(new Uint8Array(await file.arrayBuffer())) : parseCsv(await file.text());
  if (grid.length < 2) return [];
  const keys = grid[0].map(h => headerKey(String(h)));
  return grid.slice(1).map(r => Object.fromEntries(keys.map((k, i) => [k, String(r[i] ?? '').trim()])));
}
