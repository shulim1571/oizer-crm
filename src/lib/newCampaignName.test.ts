import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Readiness #56 (2026-11-15): the new-campaign form asks for the name on its first step.
describe('new campaign, first step', () => {
  it('asks for the campaign name before anything else and fills it into the next step', () => {
    const t = readFileSync('src/pages/Templates.tsx', 'utf8');
    expect(t).toContain('<label className="field"><span>Campaign name *</span>');
    expect(t).toContain("disabled={!name.trim()} onClick={() => onNext({ template, settings, name: name.trim() })}");
    expect(readFileSync('src/pages/Campaigns.tsx', 'utf8')).toContain('internal_name: choice.name || undefined');
  });
  it("takes the cover-the-fee default from the template's own setting", () => {
    expect(readFileSync('src/pages/Give.tsx', 'utf8')).toContain('useState<boolean>(!!p.cover_fee_default)');
    expect(readFileSync('src/pages/Templates.tsx', 'utf8')).toContain("cover_fee_default: false");
  });
});
