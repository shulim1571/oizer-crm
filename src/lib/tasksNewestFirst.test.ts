import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Moshe Henig, 2026-11-18 (approved by Shulim): the Tasks list opens with the newest tasks on top.
describe('Tasks list order', () => {
  const src = readFileSync('src/pages/Tasks.tsx', 'utf8');
  it('loads and shows newest first, without re-sorting by due date', () => {
    expect(src).toContain(".order('created_at', { ascending: false }).order('id')");
    expect(src).toContain("initialSort={{ key: 'created_at', dir: 'desc' }}");
    expect(src).not.toContain('sort(byDue)');
  });
});
