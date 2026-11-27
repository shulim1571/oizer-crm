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

/**
 * A blank to fill on a template whose text is already printed (Moshe's receipt design, 2026-11-22). x and y are in
 * points from the page's top-left; y is the baseline the letters sit on, so a value lines up exactly with the printed
 * word beside it. anchor: where x is (start of the text, its middle, or its end). max_width: the text shrinks to fit.
 */
export interface FillField {
  key: 'hebrew_name' | 'name' | 'amount' | 'amount_number' | 'campaign' | 'date' | 'receipt_number' | 'donor_block';
  x: number; y: number; size: number;
  anchor?: 'start' | 'middle' | 'end'; bold?: boolean; hebrew?: boolean; max_width?: number; min_size?: number; suffix?: string; color?: string;
}

export interface ReceiptLayout {
  style: 'letterhead';
  enabled?: boolean;
  /** 'fill': a letterhead image with blanks; `fields` are written by baseline (the stub), and `body` is where the
   *  receipt's wording goes (from the organization's receipt text, or the campaign's), in the template's fonts. */
  mode?: 'fill';
  fields?: FillField[];
  body?: {
    hebrew: { top: number; left: number; right: number; size: number; line_height: number; gap?: number; salutation_size?: number; salutation_line_height?: number };
    english: { top: number; left: number; width: number; size: number; line_height: number; gap?: number; max_bottom?: number };
  };
  hebrew: { right: number; left: number; lines: Line[] };
  english: { left: number; lines: Line[]; signature_top?: number; signer_title?: string; signer?: string };
  /** donor: where the donor's English name and mailing address go on the stub (Shulim, 2026-11-13). */
  stub: { amount: [number, number]; date: [number, number]; receipt_number?: [number, number]; donor?: [number, number] };
  font_size?: number;
}

export const isLetterhead = (l: unknown): l is ReceiptLayout =>
  !!l && typeof l === 'object' && (l as ReceiptLayout).style === 'letterhead'
  && ((l as ReceiptLayout).mode === 'fill' ? Array.isArray((l as ReceiptLayout).fields)
      : Array.isArray((l as ReceiptLayout).hebrew?.lines) && Array.isArray((l as ReceiptLayout).english?.lines));

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
  .letterhead .body { position: absolute; white-space: normal; color: #3a3a3a; }
  /* Hebrew in Noto Sans Hebrew, the closest free look-alike of the template's Fb Astrobol (a paid font; compared
     2026-11-22 against Moshe's PDF): Regular for the text, Medium where the template is bold. */
  .letterhead .he-body { direction: rtl; text-align: right; font-family: 'Noto Sans Hebrew', 'Arial Hebrew', Arial, sans-serif; }
  .letterhead .he-body .sal { font-weight: 500; color: #222; margin-bottom: 4pt; }
  .letterhead .en-body { font-family: 'Cabin', 'Helvetica Neue', Arial, sans-serif; }
  .letterhead .body b, .letterhead .body .fill { font-weight: 700; color: #111; }
  .letterhead .body .sig-img { max-height: 36px; display: block; margin-top: 4pt; }
  .letterhead .fill-layer { position: absolute; left: 0; top: 0; width: 8.5in; height: 11in; overflow: visible; }
  .letterhead .fill-layer text { font-family: 'Cabin', 'Helvetica Neue', Arial, sans-serif; fill: #111; }
  .letterhead .fill-layer text.he { font-family: 'Noto Sans Hebrew', 'Arial Hebrew', Arial, sans-serif; }
  .letterhead .fill-layer text.b { font-weight: 700; }
  /* Hebrew is never bold (Moshe, 2026-11-22). As in the template (Fb Astrobol Regular and Medium): the text and its
     filled-in values are Regular, and what the template sets heavier (the salutation lines, **marked** wording, a
     bold field) is Medium. English keeps its bold. */
  .letterhead .he-body, .letterhead .he-body .fill, .letterhead .he, .letterhead .he .fill, .letterhead .fill-layer text.he { font-weight: 400; }
  .letterhead .he-body .sal, .letterhead .he-body .sal .fill, .letterhead .he-body b, .letterhead .he b, .letterhead .fill-layer text.he.b { font-weight: 500; }
  /* The amount in the Hebrew text stands out (Moshe, approving the v3 sample): Medium, the template's "bold". */
  .letterhead .he-body .fill-amount { font-weight: 500; }
  .letterhead .void { position: absolute; top: 140pt; left: 50%; transform: translateX(-50%); color: #b91c1c; font-weight: bold; font-size: 18px;
    border: 2px solid #b91c1c; padding: 2px 12px; background: #fff; }
  @media screen { body { background: #e5e5e5; } .page.letterhead { margin: 16px auto; box-shadow: 0 2px 10px rgba(0,0,0,.2); } }
`;

/** Marks the filled-in parts of a line in bold, so the donor's details stand out as on a filled form. */
function lineHtml(template: string, r: Row): string {
  const parts = template.split(/(\{(?:name|hebrew_name|amount|date|campaign)\})/);
  // **...** in the wording is bold (Moshe's design sets "Dear", the מו"ה line and the signer in bold).
  // Each filled-in value is marked with its blank's name (fill-amount, fill-campaign…), so one can be styled on its own.
  return parts.map(p => (/^\{.+\}$/.test(p) ? `<span class="fill fill-${p.slice(1, -1).replace('_', '-')}">${esc(fillLine(p, r))}</span>` : esc(p))).join('')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\*\*/g, '');
}

/** The receipt's wording in a fill-in template's body area: each line of the text is a line (long ones wrap), an
 *  empty line leaves a space, and a line naming {hebrew_name} is left out when the donor has no Hebrew name. */
function bodyHtml(r: Row, l: ReceiptLayout, signature: string | null): string {
  const b = l.body;
  if (!b) return '';
  const pt = (n: number) => `${n}pt`;
  const lines = (text: string | null | undefined, gap: number, lh: number) => String(text ?? '').replace(/\r/g, '').split('\n')
    .filter(x => showsLine(x, r))
    .map((x, i) => (x.trim() ? `<div style="margin-top:${i ? pt(gap) : 0}">${lineHtml(x, r)}</div>` : `<div style="height:${pt(lh)}"></div>`)).join('');
  const he = b.hebrew;
  const sal = String(r.hebrew_salutation ?? '').trim()
    ? `<div class="sal" style="font-size:${pt(he.salutation_size ?? he.size + 1)};line-height:${pt(he.salutation_line_height ?? he.line_height + 4)}">${lines(r.hebrew_salutation, 0, he.line_height)}</div>` : '';
  const hebrew = sal || String(r.hebrew_text ?? '').trim()
    ? `<div class="body he-body" style="top:${pt(he.top)};left:${pt(he.left)};width:${pt(he.right - he.left)};font-size:${pt(he.size)};line-height:${pt(he.line_height)}">${sal}${lines(r.hebrew_text, he.gap ?? 4, he.line_height)}</div>` : '';
  const en = b.english;
  const maxH = en.max_bottom ? `max-height:${pt(en.max_bottom - en.top)};overflow:hidden;` : '';
  const english = String(r.english_text ?? '').trim()
    ? `<div class="body en-body" style="top:${pt(en.top)};left:${pt(en.left)};width:${pt(en.width)};font-size:${pt(en.size)};line-height:${pt(en.line_height)};${maxH}">${lines(r.english_text, en.gap ?? 0, en.line_height)}${signature ? `<img class="sig-img" src="${signature}" alt="">` : ''}</div>` : '';
  return hebrew + english;
}

/** One receipt on the organization's letterhead. */
/** What a field says for a receipt. */
export function fieldText(key: FillField['key'], r: Row): string {
  switch (key) {
    case 'hebrew_name': return String(r.hebrew_name ?? '').trim();
    case 'name': return [r.donor_title, r.donor_name].filter(Boolean).join(' ').trim();
    case 'amount': return money(r.amount);
    // The narrow blank after the printed "$": whole dollars without ".00" (cents kept when there are any).
    case 'amount_number': return money(r.amount).replace(/^\$/, '').replace(/\.00$/, '');
    case 'campaign': return String(r.campaign_name ?? '').trim();
    case 'date': return usDate(r.receipt_date);
    case 'receipt_number': return r.receipt_number ? `Receipt ${r.receipt_number}${r.corrects_number ? ` (corrects ${r.corrects_number})` : ''}` : '';
    default: return '';
  }
}

/**
 * The width of text at a size, from widths measured in Chrome with the receipt fonts (bold Heebo for Hebrew — Noto Sans Hebrew Medium measures within about 2% of it — bold Cabin
 * otherwise, 2026-11-22); regular weight is about 6% narrower. Receipts are drawn as static pages, so nothing measures
 * the text where they print: this is used to shrink a long value to fit its blank.
 */
export function estimatedWidth(text: string, size: number, bold = false): number {
  let em = 0;
  for (const ch of text) {
    em += /[\u0590-\u05FF]/.test(ch) ? 0.566 : /[0-9$]/.test(ch) ? 0.554 : /[.,:]/.test(ch) ? 0.227 : /[A-Z]/.test(ch) ? 0.625
      : /[a-z]/.test(ch) ? 0.49 : ch === ' ' ? 0.23 : /['"\u05F3\u05F4]/.test(ch) ? 0.26 : /[-–]/.test(ch) ? 0.33 : 0.55;
  }
  return em * size * (bold ? 1 : 0.94);
}

/** The blanks of a fill-in template, as an SVG layer over the page (SVG places text by its baseline). */
function fillLayer(r: Row, l: ReceiptLayout): string {
  const texts = (l.fields ?? []).map(f => {
    if (f.key === 'donor_block') {
      const name = fieldText('name', r);
      const lines = [name, ...String(r.donor_address ?? '').split(/\n+/).map(t => t.trim()).filter(Boolean).slice(0, 3)].filter(Boolean);
      return lines.map((t, i) => `<text x="${f.x}" y="${f.y + i * (f.size + 3)}" font-size="${f.size}" class="${i === 0 ? 'b' : ''}">${esc(t)}</text>`).join('');
    }
    const t = fieldText(f.key, r) + (f.suffix ?? '');
    if (!t.trim() || t === f.suffix) return '';
    let size = f.size;
    // A long value shrinks to fit its blank, down to the field's smallest size (9pt unless the layout says otherwise).
    if (f.max_width) { const w = estimatedWidth(t, size, f.bold); if (w > f.max_width) size = Math.max(Math.min(f.min_size ?? 9, f.size), Math.floor((size * f.max_width / w) * 10) / 10); }
    // Hebrew text (a Hebrew name, or a campaign named in Hebrew) is set right to left in the Hebrew font.
    const he = f.hebrew || /[\u0590-\u05FF]/.test(t);
    const cls = [f.bold ? 'b' : '', he ? 'he' : ''].filter(Boolean).join(' ');
    return `<text x="${f.x}" y="${f.y}" font-size="${size}" text-anchor="${f.anchor ?? 'start'}"${he ? ' direction="rtl" unicode-bidi="plaintext"' : ''}${cls ? ` class="${cls}"` : ''}${f.color ? ` fill="${f.color}"` : ''}>${esc(t)}</text>`;
  }).join('');
  return `<svg class="fill-layer" viewBox="0 0 612 792" xmlns="http://www.w3.org/2000/svg">${texts}</svg>`;
}

export function letterheadPage(r: Row, o: OrgDetails, l: ReceiptLayout, signature: string | null): string {
  if (l.mode === 'fill') {
    const voided = r.status === 'voided' ? `<div class="void">VOID${r.void_reason ? ` · ${esc(r.void_reason)}` : ''}</div>` : '';
    return `<section class="page letterhead">${voided}${bodyHtml(r, l, signature)}${fillLayer(r, l)}</section>`;
  }
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
export const LETTERHEAD_FONTS = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cabin:wght@400;700&family=Frank+Ruhl+Libre:wght@400;700&family=Noto+Sans+Hebrew:wght@400;500&display=swap">';

/** A made-up receipt for previews; never a real donor. */
export const SAMPLE_RECEIPT: Row = {
  receipt_number: 'SAMPLE-0001', donor_title: 'Mr.', donor_name: 'Sample Donor', hebrew_name: 'ר\' שמואל דוגמא',
  amount: 180, receipt_date: new Date().toISOString().slice(0, 10), campaign_name: 'Sample Campaign', status: 'issued',
  donor_address: '123 Sample St Apt 4\nBrooklyn NY 11219',
};
