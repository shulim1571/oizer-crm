import type { Row } from './supabase';
import { fillText, type OrgDetails } from './receiptHtml';

/**
 * An organization's own receipt letterhead (Shulim, 2026-11-12: Oizer's receipt is a letter page with Hebrew and
 * English thank-you text and an Official Receipt stub at the bottom). The printed letterhead (logos, rules, stub,
 * footer) is an image the organization keeps with its receipt assets; this layout says what is written on it and
 * where. Both are per organization (the receipt_layout setting and the receipt_letterhead asset), nothing is shared
 * between organizations, and it is used for real receipts only once `enabled` is set.
 *
 * Positions are in points from the top-left of a letter page (612 x 792), as measured on the organization's template.
 * Text may use {name}, {hebrew_name}, {amount}, {date} and {campaign}.
 */
/** A line of text and where its top sits, in points. */
export interface Line { top: number; text: string }

export interface ReceiptLayout {
  style: 'letterhead';
  enabled?: boolean;
  hebrew: { right: number; left: number; lines: Line[] };
  english: { left: number; lines: Line[]; signature_top?: number; signer_title?: string; signer?: string };
  /** donor: where the donor's English name and mailing address go on the stub (Shulim, 2026-11-13). */
  stub: { amount: [number, number]; date: [number, number]; receipt_number?: [number, number]; donor?: [number, number] };
  font_size?: number;
}

export const isLetterhead = (l: unknown): l is ReceiptLayout =>
  !!l && typeof l === 'object' && (l as ReceiptLayout).style === 'letterhead' && Array.isArray((l as ReceiptLayout).hebrew?.lines) && Array.isArray((l as ReceiptLayout).english?.lines);

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const money = (n: unknown) => `$${Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const usDate = (d: unknown) => (d ? new Date(`${String(d).slice(0, 10)}T12:00:00`).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }) : '');

/** Fills a line: the receipt's own placeholders, plus {hebrew_name} (the donor's Hebrew name; never the English one). */
export function fillLine(text: string, r: Row): string {
  return fillText(text.replace(/\{hebrew_name\}/g, String(r.hebrew_name ?? '').trim()), r);
}

/** No Hebrew name on file: a line that would show it is left out entirely (Shulim, 2026-11-13), not filled in English. */
export const showsLine = (text: string, r: Row) => !text.includes('{hebrew_name}') || String(r.hebrew_name ?? '').trim() !== '';

/** The styles for letterhead pages: no page margin, the organization's letterhead as each page's background. */
export const letterheadStyle = (background: string) => `
  @page { size: letter; margin: 0; }
  .page.letterhead { position: relative; width: 8.5in; height: 11in; max-width: none; margin: 0 auto; overflow: hidden;
    background-image: url("${background}"); background-size: 8.5in 11in; background-repeat: no-repeat;
    -webkit-print-color-adjust: exact; print-color-adjust: exact; font-family: 'Cabin', 'Helvetica Neue', Arial, sans-serif; color: #3a3a3a; }
  .letterhead .t { position: absolute; white-space: nowrap; line-height: 1; }
  .letterhead .he { direction: rtl; text-align: right; font-family: 'Frank Ruhl Libre', 'David', 'Times New Roman', serif; margin: 0; }
  .letterhead .fill { font-weight: 700; color: #111; }
  .letterhead .sig img { max-height: 40px; display: block; }
  .letterhead .void { position: absolute; top: 140pt; left: 50%; transform: translateX(-50%); color: #b91c1c; font-weight: bold; font-size: 18px;
    border: 2px solid #b91c1c; padding: 2px 12px; background: #fff; }
  @media screen { body { background: #e5e5e5; } .page.letterhead { margin: 16px auto; box-shadow: 0 2px 10px rgba(0,0,0,.2); } }
`;

/** Marks the filled-in parts of a line in bold, so the donor's details stand out as on a filled form. */
function lineHtml(template: string, r: Row): string {
  const parts = template.split(/(\{(?:name|hebrew_name|amount|date|campaign)\})/);
  return parts.map(p => (/^\{.+\}$/.test(p) ? `<span class="fill">${esc(fillLine(p, r))}</span>` : esc(p))).join('');
}

/** One receipt on the organization's letterhead. */
export function letterheadPage(r: Row, o: OrgDetails, l: ReceiptLayout, signature: string | null): string {
  const size = l.font_size ?? 11;
  const pt = (n: number) => `${n}pt`;
  const he = l.hebrew;
  const hebrew = he.lines.filter(x => showsLine(x.text, r)).map(x =>
    `<div class="t he" style="top:${pt(x.top)};left:${pt(he.left)};width:${pt(he.right - he.left)};font-size:${pt(size + 1)}">${lineHtml(x.text, r)}</div>`).join('');
  const en = l.english;
  const english = en.lines.map(x => `<div class="t" style="top:${pt(x.top)};left:${pt(en.left)};font-size:${pt(size + 0.5)}">${lineHtml(x.text, r)}</div>`).join('');
  const sigTop = en.signature_top ?? (en.lines.length ? en.lines[en.lines.length - 1].top + 19 : 490);
  const signer = `<div class="t sig" style="top:${pt(sigTop)};left:${pt(en.left)};font-size:${pt(size + 0.5)}">`
    + `${signature ? `<img src="${signature}" alt="">` : ''}${en.signer_title ? `<div>${esc(en.signer_title)}</div>` : ''}`
    + `<div style="margin-top:6pt">${esc(o.director_name || en.signer || '')}</div></div>`;
  const s = l.stub;
  const stub = `<div class="t fill" style="top:${pt(s.amount[1])};left:${pt(s.amount[0])};font-size:${pt(13)}">${esc(money(r.amount))}</div>`
    + `<div class="t fill" style="top:${pt(s.date[1])};left:${pt(s.date[0])};font-size:${pt(13)}">${esc(usDate(r.receipt_date))}</div>`
    + (s.receipt_number && r.receipt_number
      ? `<div class="t" style="top:${pt(s.receipt_number[1])};left:${pt(s.receipt_number[0])};font-size:${pt(9)};color:#555">Receipt ${esc(r.receipt_number)}${r.corrects_number ? ` (corrects ${esc(r.corrects_number)})` : ''}</div>`
      : '');
  // The donor's English name and mailing address on the stub, up to three address lines.
  const donorName = [r.donor_title, r.donor_name].filter(Boolean).join(' ').trim();
  const address = String(r.donor_address ?? '').split(/\n+/).map(t => t.trim()).filter(Boolean).slice(0, 3);
  const donorBlock = s.donor && (donorName || address.length)
    ? `<div class="t stub-donor" style="top:${pt(s.donor[1])};left:${pt(s.donor[0])};font-size:${pt(10)};line-height:1.25">`
      + `${donorName ? `<div class="fill">${esc(donorName)}</div>` : ''}${address.map(t => `<div>${esc(t)}</div>`).join('')}</div>`
    : '';
  const voided = r.status === 'voided' ? `<div class="void">VOID${r.void_reason ? ` · ${esc(r.void_reason)}` : ''}</div>` : '';
  return `<section class="page letterhead">${voided}${hebrew}${english}${signer}${stub}${donorBlock}</section>`;
}

/** The letterhead's fonts (loaded where the page is opened; printers and mail apps fall back to similar ones). */
export const LETTERHEAD_FONTS = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cabin:wght@400;700&family=Frank+Ruhl+Libre:wght@400;700&display=swap">';

/** A made-up receipt for previews; never a real donor. */
export const SAMPLE_RECEIPT: Row = {
  receipt_number: 'SAMPLE-0001', donor_title: 'Mr.', donor_name: 'Sample Donor', hebrew_name: 'ר\' שמואל דוגמא',
  amount: 180, receipt_date: new Date().toISOString().slice(0, 10), campaign_name: 'Sample Campaign', status: 'issued',
  donor_address: '123 Sample St Apt 4\nBrooklyn NY 11219',
};
