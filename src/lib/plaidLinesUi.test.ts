import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Readiness #33 (2026-11-15): no Delete on bank-feed lines (Set aside instead); no sandbox sign-in text.
describe('bank feed lines on the page', () => {
  it('offers Set aside, not Delete, on a line from Plaid', () => {
    const r = readFileSync('src/pages/Reconciliation.tsx', 'utf8');
    expect(r).toContain("{!l.match_id && (l.source === 'plaid'");
    expect(r).toContain("p_items: [], p_difference_type: 'other', p_note: reason.trim()");
  });
  it('shows no test sign-in credentials', () => {
    const p = readFileSync('src/pages/PlaidPanel.tsx', 'utf8');
    expect(p).not.toContain('user_good');
    expect(p).not.toContain('pass_good');
  });
});
