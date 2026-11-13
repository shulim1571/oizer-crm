import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/supabase', () => ({ supabase: {} }));
vi.mock('../lib/lookups', () => ({ campaignOptions: async () => [], clearLookups: () => {} }));

const { actionsFor } = await import('./TaskBulk');
const keys = (types: string[]) => actionsFor(types).map(a => a.key);

describe('Task Sheet bulk actions', () => {
  it('offers archive and take-off-the-sheet for inactive campaigns', () => {
    expect(keys(['inactive_campaign'])).toEqual(['archive', 'dismiss']);
  });
  it('offers assign and hold for unattributed payments', () => {
    expect(keys(['unattributed'])).toEqual(['assign', 'hold']);
    expect(actionsFor(['unattributed']).find(a => a.key === 'assign')?.needsCampaign).toBe(true);
  });
  it('only offers what fits every selected task', () => {
    expect(keys(['inactive_campaign', 'unattributed'])).toEqual([]);
    expect(keys(['stale_check', 'returned_check'])).toEqual(['dismiss']);
    expect(keys(['stale_check'])).toEqual(['cleared', 'dismiss']);
  });
  it('leaves tasks that need a decision each to one at a time', () => {
    for (const t of ['campaign_request', 'team_request', 'payout_request', 'check_to_print', 'receipt_requested', 'import_conflict']) {
      expect(keys([t])).toEqual([]);
    }
  });
  it('offers nothing with nothing selected', () => {
    expect(actionsFor([])).toEqual([]);
  });
});
