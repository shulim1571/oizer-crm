import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Moshe #44: payment page step numbers read in order on phones and on the two-column desktop layout,
// and "Cover the processing fee" starts unticked.
describe('payment page steps (Moshe #44)', () => {
  const give = readFileSync('src/pages/Give.tsx', 'utf8');
  const css = readFileSync('src/styles.css', 'utf8');
  it('numbers Amount, Your details, Payment 1-2-3 on phones and 2-1-3 on desktop', () => {
    expect(give).toContain('data-n="1" data-nd="2" aria-hidden="true" />{t.amount}');
    expect(give).toContain('data-n="2" data-nd="1" aria-hidden="true" />{t.details}');
    expect(give).toContain('data-n="3" data-nd="3" aria-hidden="true" />{L.pay_with}');
    expect(css).toMatch(/@media \(min-width: 960px\) \{ \.give-step-n::before \{ content: attr\(data-nd\); \} \}/);
    expect(css).toContain('grid-template-areas: "test test" "details amount" "details pay" "details submit"');
  });
  it('turns the cover-fee default off on existing templates and pages', () => {
    const sql = readFileSync('supabase/migrations/20261222007900_cover_fee_unticked.sql', 'utf8');
    expect(sql).toContain('update public.campaign_templates set cover_fee_default = false');
    expect(sql).toContain('update public.campaign_page_settings set cover_fee_default = false');
  });
});
