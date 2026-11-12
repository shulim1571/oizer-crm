import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('formatted description in use (Moshe Henig, 2026-11-11)', () => {
  it('is edited with the formatting editor and shown cleaned on the payment page and in link previews', () => {
    expect(readFileSync('src/pages/Templates.tsx', 'utf8')).toContain('<RichTextEditor label="Description or story" value={v.description}');
    const give = readFileSync('src/pages/Give.tsx', 'utf8');
    expect(give).toContain('dangerouslySetInnerHTML={{ __html: sanitizeHtml(text) }}');
    expect(readFileSync('functions/give/[id].ts', 'utf8')).toContain("const story = plainText(String(page.page?.description ?? ''))");
  });
});
