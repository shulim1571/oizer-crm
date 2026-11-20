import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { progressText } from './aliasMoves';

// Shulim, 2026-11-19: saving a large alias timed out. The gifts now move in batches with progress shown.
describe('alias moves in the app', () => {
  it('says how far along it is, and that fees were kept', () => {
    expect(progressText({ moved: 2000, remaining: 5973, done: false })).toBe('Moving gifts: 2,000 of 7,973 done…');
    expect(progressText({ moved: 7973, remaining: 0, done: true })).toBe('7,973 gifts moved; fees kept as recorded.');
  });
  it('runs batches after saving, on the aliases tab and on the Task Sheet', () => {
    const fees = readFileSync('src/pages/Fees.tsx', 'utf8');
    const sheet = readFileSync('src/pages/TaskSheet.tsx', 'utf8');
    const lib = readFileSync('src/lib/aliasMoves.ts', 'utf8');
    expect(lib).toContain("supabase.rpc('move_alias_gifts', { p_alias: aliasId, p_limit: batch })");
    expect(fees).toContain('<AliasMoves onDone={aliasesMoved} />');
    expect(fees).toContain('Moving gifts…');
    expect(sheet).toContain('await runAliasMove(saved.alias_id, setProgress)');
  });
});
