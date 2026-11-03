import { money } from './format';
import type { Row } from './supabase';

// Receipts and statements are pages the browser prints, which lays out Hebrew right to left properly.
// "Save as PDF" in the print dialog gives the PDF.

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const para = (s: string) => esc(s).replace(/\n/g, '<br>');
const usDate = (iso: string) => { const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number); return `${m}/${d}/${y}`; };

/** Fills {amount}, {date}, {campaign} and {name} in the text the office wrote. */
export function fillText(text: string, r: Row) {
  return text
    .replace(/\{amount\}/g, money(r.amount))
    .replace(/\{date\}/g, usDate(r.receipt_date))
    .replace(/\{campaign\}/g, r.campaign_name ?? '')
    .replace(/\{name\}/g, [r.donor_title, r.donor_name].filter(Boolean).join(' '));
}

export interface OrgDetails { name: string; legal_name?: string | null; ein?: string | null; address?: string | null; phone?: string | null; email?: string | null; director_name?: string | null; logo_url?: string | null }

const STYLE = `
  @page { size: letter; margin: 0.6in; }
  * { box-sizing: border-box; }
  body { font-family: Georgia, 'Times New Roman', serif; color: #111; margin: 0; font-size: 13px; line-height: 1.5; }
  .page { page-break-after: always; max-width: 7.3in; margin: 0 auto; }
  .page:last-child { page-break-after: auto; }
  .logo { text-align: center; margin-bottom: 14px; }
  .logo img { max-height: 80px; max-width: 260px; }
  .logo .name { font-size: 22px; font-weight: bold; }
  .he { direction: rtl; text-align: right; font-family: 'David', 'Frank Ruehl', 'Times New Roman', serif; font-size: 16px; margin: 12px 0 20px; }
  .en { margin: 12px 0 20px; }
  .sig img { max-height: 50px; display: block; }
  .official { border: 1.5px solid #111; padding: 14px 18px; margin-top: 24px; }
  .official h2 { font-size: 15px; letter-spacing: .08em; margin: 0 0 8px; display: flex; align-items: center; gap: 10px; }
  .official h2 img { max-height: 28px; }
  .row { display: flex; justify-content: space-between; gap: 16px; }
  .void { color: #b91c1c; font-weight: bold; font-size: 15px; border: 2px solid #b91c1c; display: inline-block; padding: 2px 10px; margin-bottom: 10px; }
  table { width: 100%; border-collapse: collapse; margin: 12px 0; }
  th, td { text-align: left; padding: 5px 6px; border-bottom: 1px solid #ccc; }
  td.r, th.r { text-align: right; }
  tfoot td { font-weight: bold; border-top: 2px solid #111; }
  .foot { margin-top: 28px; font-size: 11px; color: #444; text-align: center; border-top: 1px solid #ccc; padding-top: 8px; }
  .small { font-size: 11px; color: #555; }
`;

const footer = (o: OrgDetails) => {
  const bits = [o.address && `Address: ${esc(o.address)}`, o.phone && `Tel: ${esc(o.phone)}`, o.email && `Email: ${esc(o.email)}`].filter(Boolean);
  return bits.length ? `<div class="foot">${bits.join(' | ')}</div>` : '';
};
const logo = (o: OrgDetails, small = false) =>
  o.logo_url ? `<img src="${esc(o.logo_url)}" alt="" ${small ? '' : ''}>` : small ? '' : `<div class="name">${esc(o.name)}</div>`;

export function receiptPage(r: Row, o: OrgDetails, signature: string | null) {
  const items = (r.items ?? []) as Row[];
  const hebrew = r.hebrew_text
    ? `<div class="he">${r.hebrew_name ? `<p>${esc(r.hebrew_salutation || 'לכבוד ידידנו')} ${esc(r.hebrew_name)}</p>` : ''}<p>${para(fillText(r.hebrew_text, r))}</p></div>`
    : '';
  const english = r.english_text
    ? `<div class="en"><p>Dear ${esc([r.donor_title, r.donor_name].filter(Boolean).join(' '))},</p><p>${para(fillText(r.english_text, r))}</p>
       <div class="sig">${signature ? `<img src="${signature}" alt="">` : ''}${o.director_name ? `<div>${esc(o.director_name)}</div>` : ''}</div></div>`
    : '';
  const breakdown = items.length > 1
    ? `<table><thead><tr><th>Campaign</th><th class="r">Amount</th></tr></thead><tbody>${items.map(i => `<tr><td>${esc(i.campaign)}</td><td class="r">${money(i.amount)}</td></tr>`).join('')}</tbody></table>`
    : '';
  return `<section class="page">
    ${r.status === 'voided' ? `<div class="void">VOID${r.void_reason ? ` · ${esc(r.void_reason)}` : ''}</div>` : ''}
    <div class="logo">${logo(o)}</div>
    ${hebrew}${english}
    <div class="official">
      <h2>${logo(o, true)} OFFICIAL RECEIPT</h2>
      <div><b>${esc(o.legal_name || o.name)}</b></div>
      ${o.ein ? `<div>Tax ID# ${esc(o.ein)}</div>` : ''}
      <div style="margin-top:8px">Donor: ${esc([r.donor_title, r.donor_name].filter(Boolean).join(' '))}</div>
      ${r.donor_address ? `<div>${para(r.donor_address)}</div>` : ''}
      <div class="row" style="margin-top:8px"><span>Amount: <b>${money(r.amount)}</b></span><span>Date: ${usDate(r.receipt_date)}</span></div>
      ${breakdown}
      <p>No goods or benefits or intangibles were received in exchange for this contribution.</p>
      <div>Receipt ID: <b>${esc(r.receipt_number)}</b>${r.corrects_number ? ` <span class="small">(corrects ${esc(r.corrects_number)})</span>` : ''}</div>
    </div>
    ${footer(o)}
  </section>`;
}

export function statementPage(s: { donor: Row; year: number; items: Row[]; scope: string }, o: OrgDetails) {
  const total = s.items.reduce((t, i) => t + Number(i.amount), 0);
  const d = s.donor;
  return `<section class="page">
    <div class="logo">${logo(o)}</div>
    <div class="row"><div><b>${esc(o.legal_name || o.name)}</b>${o.ein ? `<br>Tax ID# ${esc(o.ein)}` : ''}${o.address ? `<br>${esc(o.address)}` : ''}</div>
      <div style="text-align:right"><b>Year-End Giving Statement</b><br>Tax year ${s.year}<br><span class="small">${esc(s.scope)}</span></div></div>
    <div style="margin:22px 0 6px">${esc([d.english_title, d.first_name, d.last_name].filter(Boolean).join(' ') || d.display_name)}</div>
    ${d.address ? `<div>${para(d.address)}</div>` : ''}${d.country && d.country !== 'US' ? `<div>${esc(d.country)}</div>` : ''}
    <table><thead><tr><th>Date</th><th>Campaign</th><th>Receipt</th><th class="r">Amount</th></tr></thead>
      <tbody>${s.items.map(i => `<tr><td>${usDate(i.gift_date)}</td><td>${esc(i.campaign_name)}</td><td>${esc(i.receipt_number ?? '')}</td><td class="r">${money(i.amount)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="3">Total giving for ${s.year}</td><td class="r">${money(total)}</td></tr></tfoot></table>
    ${s.items.length === 0 ? '<p>No tax-deductible gifts in this period.</p>' : ''}
    <p>No goods or services were provided in exchange for these contributions. Please keep this statement for your tax records.</p>
    ${footer(o)}
  </section>`;
}

/** The pages as one complete document: what prints, what an email carries and what a texted link opens. */
export const documentHtml = (title: string, pages: string[]) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>${STYLE}</style></head><body>${pages.join('')}</body></html>`;

/** Opens the pages in a new window and brings up the print dialog. */
export function printPages(title: string, pages: string[]) {
  const w = window.open('', '_blank');
  if (!w) throw new Error('The browser blocked the print window. Allow pop-ups for this site and try again.');
  w.document.write(documentHtml(title, pages));
  w.document.close();
  // Give the logo and signature a moment to load first.
  setTimeout(() => { try { w.focus(); w.print(); } catch { /* the window may have closed */ } }, 600);
}
