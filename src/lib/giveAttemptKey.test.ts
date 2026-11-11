import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Moshe Henig, 2026-11-11: the page said "something went wrong" though the gift went through, and a retry charged again.
const give = readFileSync('src/pages/Give.tsx', 'utf8');
describe('payment page attempt key', () => {
  it('sends one key per gift and keeps it across retries until a definite answer', () => {
    expect(give).toContain('attemptKey.current ??= newKey();');
    expect(give).toContain('client_key: key,');
    expect(give).toContain('if (!r.pending) attemptKey.current = null;');
  });
  it('asks what happened when the reply is lost, and shows the thank-you if it went through', () => {
    expect(give).toContain('const o = await outcome(key);');
    expect(give).toContain('if (o?.approved) { attemptKey.current = null; return onDone(o); }');
    expect(give).toContain('client_key: key, status_only: true');
  });
});
