import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Moshe Henig, 2026-11-15: the Share box shows the campaign fundraiser's email and phone, each with a copy button.
describe('Share box fundraiser contact', () => {
  const src = readFileSync('src/pages/Outreach.tsx', 'utf8');
  it('loads the campaign’s primary fundraiser and offers to copy their email and phone', () => {
    expect(src).toContain("supabase.from('managers').select('full_name, email, phone').eq('id', campaign.manager_id).maybeSingle()");
    expect(src).toContain('onClick={() => copy(fundraiser.email, setNote)}');
    expect(src).toContain('onClick={() => copy(fundraiser.phone, setNote)}');
  });
});
