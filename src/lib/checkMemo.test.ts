import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Moshe Henig, 2026-11-11: the memo on printed checks defaults to the campaign ID, not its name; still editable.
describe('check memo default', () => {
  it('is the campaign ID when printing a check, keeping a memo already on the payout', () => {
    const checks = readFileSync('src/pages/Checks.tsx', 'utf8');
    expect(checks).toContain("setMemo((m: string) => m || payout.campaign_id || '')");
    expect(checks).toContain('<label className="field"><span>Memo</span><input value={memo} onChange={e => setMemo(e.target.value)} /></label>');
  });
  it('is the campaign ID when approving a payout request', () => {
    const payouts = readFileSync('src/pages/Payouts.tsx', 'utf8');
    expect(payouts).toContain("setMemo(r.campaign_id ?? '');");
    expect(payouts).not.toContain("setMemo(r.campaigns?.external_name");
  });
});
