// Email readers for the organization inbox (Shulim, approved 2026-11-19). Each turns one kind of report into a
// "deposit" with lines, for inbox_record_deposit to store with suggested matches. They only read: nothing here posts.
// They're tolerant: whatever they can't make out goes into `notes`, and the email itself is always kept for review.
//
// Formats come from the survey of Moshe's donations mailbox (review/donations-mailbox-reconciliation-2026-11-18.md):
// the Chase notice was checked against a real one (digits masked); OJC and Pledger follow the survey's field
// descriptions until real ones arrive. Pledger's reports are PDFs: their text rows are rebuilt from text positions
// (see pdfRows in email-inbound) before reaching readPledger*.

export type Kind = 'ojc_ach' | 'pledger_ach' | 'ojc_submission' | 'pledger_batch' | 'bank_check_deposit' | 'ab_charity';
export interface Line {
  kind: 'certificate' | 'card' | 'web' | 'other';
  ref?: string | null; amount?: number | null; fee?: number | null; line_date?: string | null;
  donor_name?: string | null; donor_account?: string | null; card_last4?: string | null; trans_type?: string | null; cert_status?: string | null;
}
export interface Deposit {
  kind: Kind; issuer: string; issuer_ref?: string | null; deposit_date?: string | null;
  gross?: number | null; fees?: number | null; net?: number | null; account_last4?: string | null; notes?: string | null; lines: Line[];
}

const money = (s: string | null | undefined): number | null => {
  if (!s) return null;
  const m = /-?\(?\$?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)\)?/.exec(s);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};
const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
/** A date as YYYY-MM-DD from "11/18/2026", "2026-11-18" or "November 18, 2026". */
export function isoDate(s: string | null | undefined): string | null {
  if (!s) return null;
  let m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(s);
  if (m) { const y = m[3].length === 2 ? `20${m[3]}` : m[3]; return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`; }
  m = /([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(s);
  if (m && MONTHS[m[1].slice(0, 3).toLowerCase()]) return `${m[3]}-${String(MONTHS[m[1].slice(0, 3).toLowerCase()]).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return null;
}
/** The value after a label on the same line ("Amount funded: $1,234.50"), or on the next line. */
function after(text: string, label: RegExp): string | null {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = label.exec(lines[i]);
    if (!m) continue;
    const rest = lines[i].slice(m.index + m[0].length).replace(/^[\s:#-]+/, '').trim();
    if (rest) return rest;
    if (lines[i + 1]?.trim()) return lines[i + 1].trim();
  }
  return null;
}
const last4 = (s: string | null | undefined) => { const d = String(s ?? '').replace(/\D/g, ''); return d.length >= 4 ? d.slice(-4) : null; };
const AMT = /\$?\s?[0-9][0-9,]*\.[0-9]{2}/g;
/** A row with its number, dates, amounts and card numbers taken out, to find the donor's account number in what's left. */
const accountIn = (row: string, without: string) => {
  const rest = row.replace(without, ' ').replace(/\d{1,2}\/\d{1,2}\/\d{2,4}/g, ' ').replace(/\d{4}-\d{2}-\d{2}/g, ' ')
    .replace(AMT, ' ').replace(/(?:\*{2,}|x{2,}|X{2,}|•+\s?)\d{4}/g, ' ');
  return /\b(\d{4,9})\b/.exec(rest)?.[1] ?? null;
};

/** Which reader fits: by the trusted sender's report type, or, for a trusted sender of "other" mail (e.g. the
 *  organization's own forwarding mailbox), by what the message says. */
export function detect(reportType: string | null | undefined, subject: string, text: string, hasPdf: boolean): Kind | null {
  const typed: Record<string, Kind> = { ojc_ach: 'ojc_ach', pledger_ach: 'pledger_ach', ojc_submission: 'ojc_submission',
    pledger_batch: 'pledger_batch', bank_check_deposit: 'bank_check_deposit', ab_charity: 'ab_charity' };
  if (reportType && typed[reportType]) return typed[reportType];
  if (reportType && reportType !== 'other') return null;
  const s = subject.toLowerCase();
  if (/(we received|we accepted) your check deposit/.test(s) && /chase/i.test(text)) return 'bank_check_deposit';
  if (/ab charity/.test(s) && /payouts? (are|is) on (the|its) way/.test(s)) return 'ab_charity';
  if (/certificates? submission received/.test(s)) return 'ojc_submission';
  if (/\bach deposit\b/.test(s) && /amount funded/i.test(text)) return 'ojc_ach';
  if (/batch submission confirmation/.test(s) && hasPdf) return 'pledger_batch';
  if (/\bach notification\b/.test(s) && hasPdf) return 'pledger_ach';
  return null;
}

/** Chase "We received your check deposit" / "We accepted your check deposit(s)" (QuickDeposit). */
export function readChase(text: string): Deposit {
  const amount = money(after(text, /^\s*Amount\b/im));
  const date = isoDate(after(text, /^\s*(Received|Deposited|Accepted)\b/im)) ?? isoDate(after(text, /^\s*Date\b/im));
  const acct = /Account\s*\(\.*\s*(\d{4})\)/i.exec(text)?.[1] ?? null;
  const notes = [amount == null && 'Couldn\'t read the amount', date == null && 'Couldn\'t read the date'].filter(Boolean).join('; ') || null;
  return { kind: 'bank_check_deposit', issuer: 'Chase', deposit_date: date, net: amount, gross: amount, account_last4: acct, notes, lines: [] };
}

/** AB Charity "Payouts Are On The Way" (Moshe, 2026-11-20): total-only (AB Charity has no gift-level export), so a deposit
 *  with no lines: the gross payout, its date and the bank account's last 4, matched to a bank deposit by amount and date. */
export function readAbCharity(text: string): Deposit {
  const amount = money(after(text, /Gross Payout(?: total| amount)?/i)) ?? money(after(text, /Payout (?:total|amount)/i));
  const date = isoDate(after(text, /\b(Date|Payout date|Sent)\b/i)) ?? isoDate(text);
  const acct = /(?:ending(?: in)?|last 4|account)[^0-9]{0,20}(\d{4})\b/i.exec(text)?.[1] ?? null;
  const notes = [amount == null && 'Couldn\'t read the payout amount', date == null && 'Couldn\'t read the date'].filter(Boolean).join('; ') || null;
  return { kind: 'ab_charity', issuer: 'AB Charity', deposit_date: date, gross: amount, net: amount, account_last4: acct, notes, lines: [] };
}

/** OJC "ACH Deposit": totals by label, and one line per row holding a certificate (8 digits) or transaction (10 digits). */
export function readOjcAch(text: string): Deposit {
  const ref = /ACH\s*(?:id|ID|#|number)?\s*[:#]?\s*(\d{6,9})/.exec(text)?.[1] ?? null;
  const gross = money(after(text, /Total Amount/i));
  const planB = money(after(text, /Total Plan B Charges?/i));
  const txFee = money(after(text, /Total Transaction Fees?/i));
  const net = money(after(text, /Amount funded/i));
  const date = isoDate(after(text, /\b(Deposit date|Date)\b/i)) ?? isoDate(text);
  const lines: Line[] = [];
  for (const row of text.split('\n')) {
    const num = /(?:^|\s)(\d{8}|\d{10})(?=\s)/.exec(row);
    const amounts = row.match(AMT);
    if (!num || !amounts?.length) continue;
    const card = /(?:\*{2,}|x{2,}|X{2,}|•+\s?)(\d{4})\b/.exec(row)?.[1] ?? null;
    const kind: Line['kind'] = num[1].length === 8 ? 'certificate' : card ? 'card' : 'web';
    lines.push({ kind, ref: num[1], amount: money(amounts[0]), fee: amounts.length > 1 ? money(amounts[1]) : null,
                 line_date: isoDate(row), card_last4: card, donor_account: accountIn(row, num[1]) });
  }
  const fees = planB != null || txFee != null ? Math.round(((planB ?? 0) + (txFee ?? 0)) * 100) / 100 : null;
  const notes = [ref == null && 'Couldn\'t read the ACH id', net == null && 'Couldn\'t read the amount funded', !lines.length && 'No lines read'].filter(Boolean).join('; ') || null;
  return { kind: 'ojc_ach', issuer: 'OJC', issuer_ref: ref, deposit_date: date, gross, fees, net, notes, lines };
}

/** OJC "Certificates submission received": Batch No, and Cert # / Acct # / Amount rows. */
export function readOjcSubmission(text: string): Deposit {
  const ref = /Batch\s*No\.?\s*[:#]?\s*(\d{4,9})/i.exec(text)?.[1] ?? null;
  const review = /review process/i.test(text);
  const lines: Line[] = [];
  for (const row of text.split('\n')) {
    const cert = /(?:^|\s)(\d{8})(?=\s)/.exec(row);
    const amt = row.match(AMT);
    if (!cert || !amt) continue;
    const acct = accountIn(row, cert[1]);
    lines.push({ kind: 'certificate', ref: cert[1], amount: money(amt[amt.length - 1]), donor_account: acct, cert_status: review ? 'in_review' : 'submitted' });
  }
  const gross = money(after(text, /\bTotal\b/i));
  return { kind: 'ojc_submission', issuer: 'OJC', issuer_ref: ref, gross, deposit_date: isoDate(text), lines,
           notes: [ref == null && 'Couldn\'t read the batch number', !lines.length && 'No certificates read', review && 'OJC says this batch goes through review'].filter(Boolean).join('; ') || null };
}

/** Pledger "ACH Notification" PDF rows: Voucher # · Method · Note · Trans Type · Date · Donor · Amount · Fee · Pay Amount. */
export function readPledgerAch(rows: string[], subject: string): Deposit {
  const all = rows.join('\n');
  const lines: Line[] = [];
  for (const row of rows) {
    const date = /(\d{1,2}\/\d{1,2}\/\d{2,4})/.exec(row);
    const amounts = row.match(AMT);
    const voucher = /^\s*([A-Za-z0-9-]{4,})\b/.exec(row);
    if (!date || !amounts || amounts.length < 2 || !voucher || /total/i.test(row)) continue;
    const card = /Card\s*\(\s*\*+\s*(\d{4})\s*\)/i.exec(row)?.[1] ?? null;
    const method = card ? 'card' : /certificate/i.test(row) ? 'certificate' : /\bweb\b/i.test(row) ? 'web' : 'other';
    const trans = /(Donary|Cartis Payments|AB Charity|Org web scan)/i.exec(row)?.[1] ?? null;
    // The donor's name sits between the date and the first amount.
    const between = row.slice(row.indexOf(date[1]) + date[1].length, row.indexOf(amounts[0])).trim();
    lines.push({ kind: method as Line['kind'], ref: voucher[1], amount: money(amounts[0]), fee: money(amounts[1]), line_date: isoDate(date[1]),
                 card_last4: card, trans_type: trans, donor_name: between && !/^anonymous$/i.test(between) ? between.slice(0, 120) : null });
  }
  const net = money(after(all, /Total Pay Amount/i));
  const gross = money(after(all, /Total Transaction Amounts?/i));
  const fees = money(after(all, /Total Transaction Fees?/i));
  const batch = /Batch\s*ID\s*[:#]?\s*([A-Za-z0-9]{4,})/i.exec(all)?.[1] ?? null;
  return { kind: 'pledger_ach', issuer: 'Pledger', issuer_ref: batch, deposit_date: isoDate(subject) ?? isoDate(all), gross, fees, net, lines,
           notes: [net == null && 'Couldn\'t read the total pay amount', !lines.length && 'No lines read'].filter(Boolean).join('; ') || null };
}

/** Pledger "Batch Submission Confirmation" PDF: Batch Token, totals, and Certificate # · Amount · Status · Fee rows. */
export function readPledgerBatch(rows: string[], subject: string): Deposit {
  const all = rows.join('\n');
  const token = /Batch\s*Token\s*[:#]?\s*([A-Za-z0-9]{4,})/i.exec(all)?.[1] ?? /\(#\s*([A-Za-z0-9]{4,})\)/.exec(subject)?.[1] ?? null;
  const lines: Line[] = [];
  for (const row of rows) {
    const cert = /^\s*([A-Za-z0-9-]{4,})\b/.exec(row);
    const amounts = row.match(AMT);
    const status = /\b(Ready|Pending|Rejected)\b/i.exec(row)?.[1] ?? null;
    if (!cert || !amounts || !status || /total/i.test(row)) continue;
    lines.push({ kind: 'certificate', ref: cert[1], amount: money(amounts[0]), fee: amounts.length > 1 ? money(amounts[amounts.length - 1]) : null, cert_status: status.toLowerCase() });
  }
  return { kind: 'pledger_batch', issuer: 'Pledger', issuer_ref: token, deposit_date: isoDate(all), lines,
           gross: money(after(all, /Gross Total/i)), fees: money(after(all, /Total Fees/i)), net: money(after(all, /Net Payout/i)),
           notes: [token == null && 'Couldn\'t read the batch token', !lines.length && 'No certificates read'].filter(Boolean).join('; ') || null };
}

/**
 * Text rows from positioned PDF text items: items on the same line (by y) joined left to right. A table cell whose text
 * wraps onto the line above or below a data row (one with a date and an amount), e.g. "Card / (***4242)" or
 * "Org / web / scan", is put back into that row's cell nearest it across the page, so the row reads as one line.
 */
export function rowsFromItems(items: { str: string; x: number; y: number }[]): string[] {
  const sorted = items.filter(i => i.str.trim()).sort((a, b) => b.y - a.y || a.x - b.x);
  type Part = { x: number; s: string };
  const rows: { y: number; parts: Part[] }[] = [];
  for (const it of sorted) {
    const row = rows.find(r => Math.abs(r.y - it.y) < 3);
    if (row) row.parts.push({ x: it.x, s: it.str.trim() }); else rows.push({ y: it.y, parts: [{ x: it.x, s: it.str.trim() }] });
  }
  for (const r of rows) r.parts.sort((a, b) => a.x - b.x);
  const isData = (r: { parts: Part[] }) => { const t = r.parts.map(p => p.s).join(' '); return /\d{1,2}\/\d{1,2}\/\d{2,4}/.test(t) && /\$?\d[\d,]*\.\d{2}/.test(t); };
  const data = rows.filter(isData);
  const merged = new Set<number>();
  rows.forEach((r, i) => {
    if (isData(r)) return;
    let best: { y: number; parts: Part[] } | null = null;
    for (const d of data) if (Math.abs(d.y - r.y) <= 16 && (!best || Math.abs(d.y - r.y) < Math.abs(best.y - r.y))) best = d;
    // Only short fragments (wrapped cell text), not a heading or total line that happens to sit close.
    if (!best || r.parts.length > best.parts.length || /total|number of/i.test(r.parts.map(p => p.s).join(' '))) return;
    const above = r.y > best.y;
    for (const frag of r.parts) {
      const cell = best.parts.reduce((a, b) => (Math.abs(b.x - frag.x) < Math.abs(a.x - frag.x) ? b : a));
      // A cell with no text on the data row's own line: the fragment starts it, and its other half joins it later.
      if (Math.abs(cell.x - frag.x) > 20) { best.parts.push({ x: frag.x, s: frag.s }); best.parts.sort((p, q) => p.x - q.x); continue; }
      cell.s = above ? `${frag.s} ${cell.s}` : `${cell.s} ${frag.s}`;
    }
    merged.add(i);
  });
  return rows.filter((_, i) => !merged.has(i)).map(r => r.parts.map(p => p.s).join('  '));
}
