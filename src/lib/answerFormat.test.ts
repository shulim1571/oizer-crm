import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseAnswer, parseInline } from './answerFormat';

// Shulim, 2026-11-11: the help assistant's answers showed raw **asterisks**. They're now rendered, safely.
const REAL = `On the payout, use **Print check**. The payout's method must be **Check**.

Steps:
1. Open the payout.
2. Confirm the method is Check.
3. Click **Print check**.

If it says the page is out of date, reload the page and try again.`;

describe('assistant answer formatting', () => {
  it('turns bold, italic and code into formatting instead of showing the symbols', () => {
    expect(parseInline('Use **Print check**, then *wait* for `check-5007.pdf`.')).toEqual([
      { text: 'Use ' }, { text: 'Print check', bold: true }, { text: ', then ' }, { text: 'wait', italic: true },
      { text: ' for ' }, { text: 'check-5007.pdf', code: true }, { text: '.' },
    ]);
  });

  it('keeps paragraphs and numbered steps from a real answer', () => {
    const blocks = parseAnswer(REAL);
    expect(blocks.map(b => b.kind)).toEqual(['p', 'p', 'ol', 'p']);
    const steps = blocks[2];
    if (steps.kind !== 'ol') throw new Error('expected steps');
    expect(steps.start).toBe(1);
    expect(steps.items).toHaveLength(3);
    expect(steps.items[2]).toEqual([{ text: 'Click ' }, { text: 'Print check', bold: true }, { text: '.' }]);
    expect(JSON.stringify(blocks)).not.toContain('**');
  });

  it('handles bullets and leaves anything unknown as plain text', () => {
    expect(parseAnswer('- one\n- two').map(b => b.kind)).toEqual(['ul']);
    expect(parseInline('5 * 3 = 15')).toEqual([{ text: '5 * 3 = 15' }]);
  });

  it('never inserts an answer as HTML: tags stay text', () => {
    expect(parseInline('<img src=x onerror=alert(1)> **ok**')[0]).toEqual({ text: '<img src=x onerror=alert(1)> ' });
    const ui = readFileSync('src/pages/Assistant.tsx', 'utf8');
    expect(ui).not.toContain('dangerouslySetInnerHTML');
    expect(ui).toContain("t.role === 'assistant' ? <Answer text={t.content} />");
  });

  it('asks the model for only that simple formatting', () => {
    expect(readFileSync('supabase/functions/_shared/assistant.ts', 'utf8')).toMatch(/Formatting: only \*\*bold\*\*[^]*No headings, tables,\s*links or HTML/);
  });
});
