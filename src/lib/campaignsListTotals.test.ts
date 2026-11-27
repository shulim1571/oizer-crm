import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Readiness #38 (2026-11-15): the Campaigns list adds up: Raised - Fees - Expenses = Balance; teams say where their
// money is; a Below zero quick filter.
describe('Campaigns list', () => {
  const c = readFileSync('src/pages/Campaigns.tsx', 'utf8');
  it('shows fees, and the totals add up to the balance', () => {
    expect(c).toContain("{ key: 'fees', label: 'Fees', render: r => money(r.fees), align: 'right' },");
    expect(c).toContain('<Kpi label="Fees" value={money(fees)}');
    expect(c).toContain('sub={`= raised − fees − expenses');
  });
  it('says a team\'s balance is in its parent, instead of $0.00', () => {
    expect(c).toContain('<span className="muted">Shared (in parent #{r.parent_campaign_id})</span>');
  });
  it('has a Below zero quick filter', () => {
    expect(c).toContain("(r.balance_mode !== 'shared' && Number(r.balance) < 0)");
    expect(c).toContain('aria-pressed={belowZero} onClick={() => setBelowZero(b => !b)}');
  });
});
