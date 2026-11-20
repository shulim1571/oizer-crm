import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Moshe Henig, 2026-11-11 (screenshot): the Check Register's rows ran over the check printing settings below them.
describe('lists inside a page', () => {
  it('take their natural height, so nothing below them is covered', () => {
    expect(readFileSync('src/styles.css', 'utf8')).toContain('.view > .view { flex: none; min-height: auto; }');
  });
});
