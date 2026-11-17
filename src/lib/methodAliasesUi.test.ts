import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Shulim, 2026-11-17: method aliases under Payment Methods & Fees, and "Map to existing method" on the Task Sheet.
describe('method aliases in the app', () => {
  it('the Task Sheet No Fee Rule item offers Map to existing method', () => {
    const src = readFileSync('src/pages/TaskSheet.tsx', 'utf8');
    expect(src).toContain("{item.record_id && <MapMethod name={String(item.record_id)}");
    expect(src).toContain("supabase.rpc('map_payment_method', { p_alias: name, p_method: method })");
    expect(src).toContain('Map to existing method');
  });
  it('Settings has a Method aliases tab saying what saving does', () => {
    const src = readFileSync('src/pages/Fees.tsx', 'utf8');
    expect(src).toContain("['aliases', 'Method aliases']");
    expect(src).toContain('their fees stay as recorded');
    expect(src).toContain("'Suggestion'");
  });
});
