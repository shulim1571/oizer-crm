import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

// Check on top of a letter page, two stubs below. Points: 72 to the inch, origin at the bottom left.
const PAGE_W = 612;
const PAGE_H = 792;
const CHECK_BOTTOM = PAGE_H - 252;
const MICR_PITCH = 9; // 8 characters to the inch, as E-13B requires
const MICR_BASELINE = CHECK_BOTTOM + 13.5; // 3/16 inch above the bottom edge
const MM = 72 / 25.4;

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen',
  'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function belowThousand(n: number): string {
  const parts: string[] = [];
  if (n >= 100) parts.push(`${ONES[Math.floor(n / 100)]} Hundred`);
  const rest = n % 100;
  if (rest >= 20) parts.push(TENS[Math.floor(rest / 10)] + (rest % 10 ? `-${ONES[rest % 10]}` : ''));
  else if (rest > 0) parts.push(ONES[rest]);
  return parts.join(' ');
}

/** "Five Hundred and 00/100", as written on a check. */
export function amountInWords(amount: number): string {
  const cents = Math.round(amount * 100);
  const dollars = Math.floor(cents / 100);
  const scales: [number, string][] = [[1e9, 'Billion'], [1e6, 'Million'], [1e3, 'Thousand'], [1, '']];
  const words: string[] = [];
  let left = dollars;
  for (const [size, name] of scales) {
    const chunk = Math.floor(left / size);
    if (chunk) words.push(`${belowThousand(chunk)}${name ? ` ${name}` : ''}`);
    left %= size;
  }
  return `${words.join(' ') || 'Zero'} and ${String(cents % 100).padStart(2, '0')}/100`;
}

/** "$1,234.50**": padded so nothing can be added in front or behind. */
export function amountInFigures(amount: number): string {
  const text = amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `$${text}${'*'.repeat(Math.max(2, 12 - text.length))}`;
}

export interface MicrChar { position: number; char: string }

/**
 * The MICR line by field position, counted from the check's right edge at 1/8 inch each:
 * on-us (account number) ends at 14, transit (routing) runs 33 to 43, auxiliary on-us (check number) ends at 45.
 * Symbols are the font's characters for the transit and on-us marks.
 */
export function micrLine(checkNumber: number, routing: string, account: string, transit = 'A', onUs = 'C'): MicrChar[] {
  const place = (text: string, rightmost: number) => [...text].reverse().map((char, i) => ({ position: rightmost + i, char }));
  return [
    ...place(`${account}${onUs}`, 14),
    ...place(`${transit}${routing}${transit}`, 33),
    ...place(`${onUs}${checkNumber}${onUs}`, 45),
  ].sort((a, b) => b.position - a.position);
}

export interface CheckData {
  checkNumber: number;
  date: string; // M/D/YYYY
  payee: string;
  amount: number;
  memo?: string | null;
  campaign?: string | null;
  printName: string;
  printAddress?: string | null;
  bankName: string;
  routing: string;
  account: string;
  offsetX?: number; // millimetres, to line up with the check stock
  offsetY?: number;
  signature?: { bytes: Uint8Array; mime: string } | null;
  micrFont?: { bytes: Uint8Array; transit?: string | null; onUs?: string | null } | null;
  /** A test print: marked VOID and never depositable. */
  sample?: boolean;
}

function text(page: PDFPage, s: string, x: number, y: number, font: PDFFont, size: number, align: 'left' | 'right' | 'center' = 'left') {
  const w = font.widthOfTextAtSize(s, size);
  page.drawText(s, { x: align === 'right' ? x - w : align === 'center' ? x - w / 2 : x, y, size, font });
}

/** Shrinks text until it fits the width. */
function fitted(font: PDFFont, s: string, size: number, width: number) {
  let n = size;
  while (n > 6 && font.widthOfTextAtSize(s, n) > width) n -= 0.5;
  return n;
}

export async function buildCheckPdf(c: CheckData): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle(`Check ${c.checkNumber}`);
  const page = doc.addPage([PAGE_W, PAGE_H]);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ox = (c.offsetX ?? 0) * MM;
  const oy = (c.offsetY ?? 0) * MM;
  const X = (x: number) => x + ox;
  const Y = (y: number) => y + oy;
  const line = (x1: number, x2: number, y: number) => page.drawLine({ start: { x: X(x1), y: Y(y) }, end: { x: X(x2), y: Y(y) }, thickness: 0.6 });

  // The check
  text(page, c.printName, X(36), Y(756), bold, 11);
  (c.printAddress ?? '').split('\n').filter(Boolean).slice(0, 3).forEach((l, i) => text(page, l, X(36), Y(744 - i * 10), regular, 8));
  text(page, c.bankName, X(306), Y(756), regular, 9, 'center');
  text(page, String(c.checkNumber), X(576), Y(756), bold, 11, 'right');
  text(page, `Date  ${c.date}`, X(576), Y(728), regular, 10, 'right');

  text(page, 'PAY TO THE', X(36), Y(697), regular, 6.5);
  text(page, 'ORDER OF', X(36), Y(689), regular, 6.5);
  text(page, c.payee, X(84), Y(691), bold, fitted(bold, c.payee, 11, 380));
  line(80, 470, 688);
  page.drawRectangle({ x: X(482), y: Y(683), width: 94, height: 20, borderWidth: 0.8, borderColor: rgb(0, 0, 0) });
  text(page, amountInFigures(c.amount), X(572), Y(689), bold, 11, 'right');

  const words = amountInWords(c.amount);
  const wordSize = fitted(regular, words, 10, 470);
  const pad = '*'.repeat(Math.max(0, Math.floor((480 - regular.widthOfTextAtSize(words, wordSize)) / regular.widthOfTextAtSize('*', wordSize))));
  text(page, `${words}${pad}`, X(36), Y(662), regular, wordSize);
  line(36, 520, 659);
  text(page, 'DOLLARS', X(576), Y(662), bold, 9, 'right');

  text(page, 'MEMO', X(36), Y(600), regular, 6.5);
  if (c.memo) text(page, c.memo, X(64), Y(602), regular, fitted(regular, c.memo, 9, 250));
  line(62, 320, 598);
  line(372, 576, 598);
  text(page, 'AUTHORIZED SIGNATURE', X(474), Y(589), regular, 6, 'center');
  if (c.signature && !c.sample) {
    const img = c.signature.mime === 'image/png' ? await doc.embedPng(c.signature.bytes) : await doc.embedJpg(c.signature.bytes);
    const scale = Math.min(190 / img.width, 42 / img.height);
    page.drawImage(img, { x: X(474 - (img.width * scale) / 2), y: Y(599), width: img.width * scale, height: img.height * scale });
  }

  // MICR line, each character at its exact position
  const micrFont = c.micrFont ? await doc.embedFont(c.micrFont.bytes, { subset: false }) : null;
  const chars = micrLine(c.checkNumber, c.routing, c.account, c.micrFont?.transit || 'A', c.micrFont?.onUs || 'C');
  for (const m of chars) {
    page.drawText(m.char, { x: X(PAGE_W - m.position * MICR_PITCH), y: Y(MICR_BASELINE), size: 12, font: micrFont ?? regular });
  }

  if (c.sample || !micrFont) {
    page.drawText(c.sample ? 'VOID  SAMPLE' : 'VOID  NO MICR FONT', {
      x: 150, y: CHECK_BOTTOM + 60, size: 44, font: bold, color: rgb(0.8, 0.1, 0.1), opacity: 0.35, rotate: degrees(12),
    });
  }

  // Two stubs for the records
  for (const top of [500, 248]) {
    text(page, c.printName, 36, top, bold, 10);
    text(page, `Check ${c.checkNumber}`, 576, top, bold, 10, 'right');
    const rows: [string, string][] = [
      ['Date', c.date], ['Pay to', c.payee], ['Amount', amountInFigures(c.amount).replace(/\*+$/, '')],
      ['Memo', c.memo ?? ''], ['Campaign', c.campaign ?? ''], ['Account', `${c.bankName} ····${c.account.slice(-4)}`],
    ];
    rows.forEach(([k, v], i) => {
      text(page, k, 36, top - 22 - i * 15, regular, 9);
      text(page, v, 110, top - 22 - i * 15, regular, 9);
    });
  }
  return doc.save();
}

export { fromBase64 } from './base64';
export const toBase64 = async (file: File) => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
