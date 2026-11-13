// The campaign description is formatted text (Moshe Henig, 2026-11-11: fonts, bold and so on). It's stored as a
// small, cleaned-up subset of HTML: only the tags and styles below survive, everything else is dropped. Cleaned when
// saved and again when shown. Older plain-text descriptions still show as before.

export const FONTS = ['Arial', 'Georgia', 'Times New Roman', 'Verdana', 'Trebuchet MS', 'Courier New', 'Tahoma', 'David', 'Frank Ruehl'];
export const SIZES = ['12px', '14px', '16px', '18px', '22px', '28px'];
const TAGS = new Set(['P', 'DIV', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'UL', 'OL', 'LI', 'H3', 'H4', 'BLOCKQUOTE', 'SPAN', 'A']);
const DROP_WITH_CONTENT = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE', 'SVG', 'MATH', 'NOSCRIPT', 'TITLE', 'HEAD', 'META', 'LINK']);
// The editor's font sizes 1-7 (from the browser's own commands), as pixel sizes.
const FONT_SIZE: Record<string, string> = { 1: '12px', 2: '14px', 3: '16px', 4: '18px', 5: '22px', 6: '28px', 7: '28px' };

/** True when the text is formatted (HTML from the editor) rather than an older plain-text description. */
export const isRichText = (text: string | null | undefined) => /<\/?(p|div|br|b|strong|i|em|u|s|ul|ol|li|h3|h4|blockquote|span|a|font)\b[^>]*>/i.test(text ?? '');

function cleanStyle(style: string): string {
  const keep: string[] = [];
  for (const part of style.split(';')) {
    const [k, ...rest] = part.split(':');
    const prop = k?.trim().toLowerCase();
    const val = rest.join(':').trim();
    if (prop === 'font-family') {
      const font = FONTS.find(f => val.replace(/["']/g, '').toLowerCase().startsWith(f.toLowerCase()));
      if (font) keep.push(`font-family: '${font}'`);
    } else if (prop === 'font-size' && SIZES.includes(val)) keep.push(`font-size: ${val}`);
    else if (prop === 'text-align' && /^(left|right|center)$/.test(val)) keep.push(`text-align: ${val}`);
    else if (prop === 'font-weight' && /^(bold|700)$/.test(val)) keep.push('font-weight: bold');
    else if (prop === 'font-style' && val === 'italic') keep.push('font-style: italic');
    else if (prop === 'text-decoration' && /^(underline|line-through)$/.test(val)) keep.push(`text-decoration: ${val}`);
  }
  return keep.join('; ');
}

/** The description reduced to the allowed formatting. Needs a browser DOM (the editor and the payment page). */
export function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const out = doc.createElement('div');
  const copy = (from: Node, to: Node) => {
    for (const n of Array.from(from.childNodes)) {
      if (n.nodeType === 3) { to.appendChild(doc.createTextNode(n.textContent ?? '')); continue; }
      if (n.nodeType !== 1) continue;
      const el = n as Element;
      let tag = el.tagName.toUpperCase();
      if (DROP_WITH_CONTENT.has(tag)) continue;
      // The editor's <font face size> becomes a styled <span>.
      let style = el.getAttribute('style') ?? '';
      if (tag === 'FONT') {
        const face = el.getAttribute('face');
        const size = FONT_SIZE[el.getAttribute('size') ?? ''];
        style = `${face ? `font-family: ${face};` : ''}${size ? `font-size: ${size};` : ''}${style}`;
        tag = 'SPAN';
      }
      if (!TAGS.has(tag)) { copy(el, to); continue; }   // unknown tag: keep its text, drop the tag
      const keep = doc.createElement(tag.toLowerCase());
      const s = cleanStyle(style);
      if (s && tag !== 'BR') keep.setAttribute('style', s);
      if (tag === 'A') {
        const href = (el.getAttribute('href') ?? '').trim();
        if (/^(https?:\/\/|mailto:)/i.test(href)) {
          keep.setAttribute('href', href);
          keep.setAttribute('target', '_blank');
          keep.setAttribute('rel', 'noopener noreferrer nofollow');
        }
      }
      copy(el, keep);
      to.appendChild(keep);
    }
  };
  copy(doc.body, out);
  return out.innerHTML;
}

/** Plain text of a description (formatted or not), for link previews and length checks. Works without a DOM. */
export function plainText(text: string | null | undefined): string {
  const t = String(text ?? '');
  if (!isRichText(t)) return t;
  return t
    .replace(/<(br|\/p|\/div|\/li|\/h3|\/h4|\/blockquote)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n').trim();
}

/** An older plain-text description as HTML for the editor: escaped, line breaks kept. */
export function textToHtml(text: string): string {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc.split(/\n{2,}/).map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
}
