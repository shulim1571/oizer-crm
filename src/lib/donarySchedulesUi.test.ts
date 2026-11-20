import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// AppSheet gap review #6 (2026-11-19): Donary-run schedules are listed, read-only, on the Recurring page.
describe('Donary schedules on the Recurring page', () => {
  const src = readFileSync('src/pages/Recurring.tsx', 'utf8');
  it('lists them from donary_schedule_list with payments, next expected and status, and offers no edit', () => {
    expect(src).toContain("supabase.from('donary_schedule_list')");
    expect(src).toContain('<DonarySchedules />');
    expect(src).toContain("label: 'Next expected'");
    const block = src.slice(src.indexOf('function DonarySchedules'));
    expect(block.slice(0, block.indexOf('\n}\n'))).not.toMatch(/onOpen|rpc\(/);
  });
});
