import { parseCsv, parseXlsx } from './sheets';

// Reading a bank's statement export. Every bank lays these out differently, so the file is read as a grid, the
// header row is found, the columns are guessed from their names, and the person can change any guess.

export interface BankMapping {
  date: number;
  description: number | null;
  /** One signed amount column, or separate debit and credit columns. */
  amount: number | null;
  debit: number | null;
  credit: number | null;
  checkNumber: number | null;
  reference: number | null;
  /** For a single amount column whose withdrawals are positive (some banks show them that way). */
  flipSign: boolean;
}

export interface BankLine { date: string; amount: number; description: string | null; check_number: string | null; bank_ref: string | null }

export interface BankFile { headers: string[]; rows: string[][] }

const norm = (h: string) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** The first row that looks like headers: it names a date column and some amount column. */
export function findHeader(grid: string[][]): BankFile {
  const at = grid.findIndex(r => {
    const cells = r.map(c => norm(String(c)));
    return cells.some(c => /\bdate\b/.test(c)) && cells.some(c => /amount|debit|credit|withdrawal|deposit/.test(c));
  });
  if (at < 0) throw new Error('Couldn\'t find the header row. The file needs a date column and an amount column.');
  const headers = grid[at].map(h => String(h).trim());
  return { headers, rows: grid.slice(at + 1).filter(r => r.some(c => String(c).trim() !== '')) };
}

export async function readBankFile(file: File): Promise<BankFile> {
  const grid = /\.xlsx$/i.test(file.name) ? parseXlsx(new Uint8Array(await file.arrayBuffer())) : parseCsv(await file.text());
  return findHeader(grid);
}

export function guessMapping(headers: string[]): BankMapping {
  const h = headers.map(norm);
  const find = (...tests: RegExp[]) => {
    for (const t of tests) { const i = h.findIndex(x => t.test(x)); if (i >= 0) return i; }
    return null;
  };
  const debit = find(/^debit/, /withdrawal/, /^money out/, /^paid out/);
  const credit = find(/^credit/, /deposit/, /^money in/, /^paid in/);
  const amount = find(/^amount$/, /^transaction amount/, /amount/);
  return {
    date: find(/^posting date/, /^posted date/, /^post date/, /^date$/, /^transaction date/, /date/) ?? 0,
    description: find(/^description/, /^memo/, /^payee/, /^details/, /^narrative/, /name/),
    amount: debit !== null && credit !== null ? null : amount,
    debit: debit !== null && credit !== null ? debit : null,
    credit: debit !== null && credit !== null ? credit : null,
    checkNumber: find(/^check/, /^cheque/, /chk/),
    reference: find(/^reference/, /^ref\b/, /transaction id/, /^fitid/, /confirmation/),
    flipSign: false,
  };
}

/** "$1,234.56", "(12.00)", "-12", "12.00 CR", "1.234,56" is not supported (US banks only). */
export function parseAmount(raw: string | undefined): number | null {
  let s = String(raw ?? '').trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (/\b(dr|debit)\.?$/i.test(s)) { neg = true; s = s.replace(/\b(dr|debit)\.?$/i, ''); }
  s = s.replace(/\b(cr|credit)\.?$/i, '');
  s = s.replace(/[$,\s]/g, '');
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
  if (s.endsWith('-')) { neg = !neg; s = s.slice(0, -1); }
  if (s.startsWith('+')) s = s.slice(1);
  if (!/^\d*\.?\d+$/.test(s)) return null;
  const n = Math.round(Number(s) * 100) / 100;
  return neg ? -n : n;
}

/** To YYYY-MM-DD from 2026-10-01, 10/01/2026, 10/1/26, 20261001, or "Oct 1, 2026". */
export function parseDate(raw: string | undefined): string | null {
  const s = String(raw ?? '').trim().replace(/\s+\d{1,2}:\d{2}(:\d{2})?(\s*[ap]m)?$/i, '');
  if (!s) return null;
  const ok = (y: number, m: number, d: number) => {
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d
      ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null;
  };
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return ok(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/);
  if (m) return ok(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[1], +m[2]);
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return ok(+m[1], +m[2], +m[3]);
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  m = s.match(/^([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/i);
  if (m && months.includes(m[1].toLowerCase())) return ok(+m[3], months.indexOf(m[1].toLowerCase()) + 1, +m[2]);
  m = s.match(/^(\d{1,2})\s+([a-z]{3})[a-z]*\.?\s+(\d{4})$/i);
  if (m && months.includes(m[2].toLowerCase())) return ok(+m[3], months.indexOf(m[2].toLowerCase()) + 1, +m[1]);
  return null;
}

/** Turns the grid into lines, with money in positive. Problems are listed by the file's row number. */
export function toLines(file: BankFile, map: BankMapping): { lines: BankLine[]; problems: string[]; skippedZero: number } {
  const lines: BankLine[] = [];
  const problems: string[] = [];
  let skippedZero = 0;
  const cell = (r: string[], i: number | null) => (i === null ? '' : String(r[i] ?? '').trim());
  file.rows.forEach((r, n) => {
    const rowNo = n + 2;
    const date = parseDate(cell(r, map.date));
    let amount: number | null;
    if (map.amount !== null) {
      amount = parseAmount(cell(r, map.amount));
      if (amount !== null && map.flipSign) amount = -amount;
    } else {
      const d = parseAmount(cell(r, map.debit));
      const c = parseAmount(cell(r, map.credit));
      amount = d === null && c === null ? null : (c ?? 0) - Math.abs(d ?? 0);
    }
    // Summary rows such as "Ending balance" have no date: leave them out quietly.
    if (!date && !cell(r, map.date)) return;
    if (!date) { problems.push(`Row ${rowNo}: can't read the date "${cell(r, map.date)}"`); return; }
    if (amount === null) { problems.push(`Row ${rowNo}: no amount`); return; }
    if (amount === 0) { skippedZero++; return; }
    const desc = cell(r, map.description);
    const check = cell(r, map.checkNumber).replace(/\D/g, '') || (desc.match(/\b(?:check|chk|ck)\s*#?\s*(\d{3,})\b/i)?.[1] ?? '');
    lines.push({ date, amount, description: desc || null, check_number: check || null, bank_ref: cell(r, map.reference) || null });
  });
  return { lines, problems, skippedZero };
}
