import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Moshe Henig, 2026-11-15: the Task Sheet shows each Unattributed payment's source (and other donation tasks').
describe('Task Sheet source column', () => {
  const src = readFileSync('src/pages/TaskSheet.tsx', 'utf8');
  it('has a Source column filled from the donation for donation tasks', () => {
    expect(src).toContain("{ key: 'source_label', label: 'Source', width: 140 },");
    expect(src).toContain("supabase.from('transaction_list').select('id, source, source_name').in('id', ids)");
    expect(src).toContain('return withSources(await withCampaigns(tasks));');
    expect(src).toMatch(/TRANSACTION_TASKS = new Set\(\[[^\]]*'unattributed'/);
  });
});
