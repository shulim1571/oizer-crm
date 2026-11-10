import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { newPayoutDefaults } from './schemas';

// Moshe Henig, 2026-11-10: a new payout's "Process on" starts at today (and its timestamp at now), still editable.
describe('new payout defaults', () => {
  it('process on today, timestamped now', () => {
    const d = newPayoutDefaults();
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    expect(d.scheduled_for).toBe(today);
    expect(Math.abs(new Date(d.created_at).getTime() - Date.now())).toBeLessThan(5000);
  });
  it('is used by both New payout forms, and only for new ones', () => {
    expect(readFileSync('src/pages/SimplePages.tsx', 'utf8')).toContain('defaults={{ account_id: defaultAccountId, ...newPayoutDefaults() }}');
    const campaign = readFileSync('src/pages/CampaignDetail.tsx', 'utf8');
    expect(campaign).toContain("title: 'New Payout', fields: expenseFields, defaults: { campaign_id: id, account_id: defaultAccountId, ...newPayoutDefaults() }");
    expect(campaign).toMatch(/title: 'Edit Payout', fields: expenseFields \}/);
  });
});
