import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Moshe Henig, 2026-11-16: the Task Sheet opens with the latest tasks on top.
describe('Task Sheet order', () => {
  const src = readFileSync('src/pages/TaskSheet.tsx', 'utf8');
  it('loads and shows newest first', () => {
    expect(src).toContain(".order('submitted_at', { ascending: false }).order('task_key')");
    expect(src).toContain("initialSort={{ key: 'submitted_at', dir: 'desc' }}");
  });
});
