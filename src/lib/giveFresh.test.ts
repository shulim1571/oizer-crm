import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Moshe Henig, 2026-11-11: the payment page always shows the campaign's current details, never a stale copy.
describe('payment page freshness', () => {
  it('is never cached by browsers or Cloudflare', () => {
    expect(readFileSync('functions/give/[id].ts', 'utf8')).toContain("'Cache-Control': 'no-cache',");
    expect(readFileSync('public/_headers', 'utf8')).toMatch(/\/give\/\*\n {2}Cache-Control: no-cache/);
  });
  it('reloads the campaign when you come back to an open page', () => {
    const g = readFileSync('src/pages/Give.tsx', 'utf8');
    expect(g).toContain("document.addEventListener('visibilitychange', fresh);");
  });
});
