/**
 * The help assistant's answers use simple markdown (**bold**, *italic*, `code`, lists). This turns it into plain
 * data the chat panel renders as React elements: nothing is ever inserted as HTML, so any HTML in an answer shows
 * as text. Anything it doesn't understand stays as written.
 */
export type Inline = { text: string; bold?: boolean; italic?: boolean; code?: boolean };
export type Block = { kind: 'p'; lines: Inline[][] } | { kind: 'ul'; items: Inline[][] } | { kind: 'ol'; items: Inline[][]; start: number } | { kind: 'h'; text: Inline[] };

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const re = /(\*\*([^*\n]+)\*\*|__([^_\n]+)__|`([^`\n]+)`|\*([^*\n]+)\*|_([^_\n]+)_)/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    if (m[2] ?? m[3]) out.push({ text: (m[2] ?? m[3])!, bold: true });
    else if (m[4]) out.push({ text: m[4], code: true });
    else out.push({ text: (m[5] ?? m[6])!, italic: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out.length ? out : [{ text: '' }];
}

export function parseAnswer(text: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const numbered = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    const heading = line.match(/^\s*#{1,6}\s+(.*)$/);
    const prev = blocks[blocks.length - 1];
    if (!line.trim()) { blocks.push({ kind: 'p', lines: [] }); continue; }
    if (heading) blocks.push({ kind: 'h', text: parseInline(heading[1]) });
    else if (bullet) {
      if (prev?.kind === 'ul') prev.items.push(parseInline(bullet[1])); else blocks.push({ kind: 'ul', items: [parseInline(bullet[1])] });
    } else if (numbered) {
      if (prev?.kind === 'ol') prev.items.push(parseInline(numbered[2])); else blocks.push({ kind: 'ol', items: [parseInline(numbered[2])], start: Number(numbered[1]) });
    } else if (prev?.kind === 'p' && prev.lines.length) prev.lines.push(parseInline(line));
    else if (prev?.kind === 'p') prev.lines.push(parseInline(line));
    else blocks.push({ kind: 'p', lines: [parseInline(line)] });
  }
  return blocks.filter(b => b.kind !== 'p' || b.lines.length > 0);
}
