import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { balanceAfterColumn, balanceIndex, statementColumns, type StatementLine } from './campaignStatement';

// The running campaign balance on campaign transactions (Shulim, 2026-11-25). Sample data only.
const line = (kind: StatementLine['kind'], id: string, change: number, balance: number): StatementLine =>
  ({ kind, id, campaign_id: '1001', at: '2026-11-25T10:00:00Z', description: 'Sample', money_in: Math.max(change, 0), fee: 0, money_out: Math.max(-change, 0), change, balance });

describe('campaign statement on the campaign page', () => {
  // Newest first, as loadStatement returns it.
  const lines = [line('transfer_in', 't1', 10, 135), line('transfer_out', 't1', -10, 125), line('payout', 'e1', -50, 135), line('donation', 'g1', 185, 185)];

  it('finds the balance after each gift, payout and transfer (an in-group transfer: after both sides)', () => {
    const idx = balanceIndex(lines);
    expect(idx.get('donation:g1')).toBe(185);
    expect(idx.get('payout:e1')).toBe(135);
    expect(idx.get('transfer:t1')).toBe(135);
    const col = balanceAfterColumn(idx, 'donation');
    expect(col.label).toBe('Balance after');
    expect(col.value!({ id: 'g1' })).toBe(185);
    expect(col.value!({ id: 'pending-gift' })).toBeNull();   // moves no money: shown as a dash
  });

  it('shows date, type, description, in, fee, out and balance (campaign too, with shared teams)', () => {
    expect(statementColumns(false).map(c => c.label)).toEqual(['Date', 'Type', 'Description', 'In', 'Fee', 'Out', 'Balance']);
    expect(statementColumns(true).map(c => c.label)).toContain('Campaign');
  });

  it('is on the campaign page for staff: a Statement tab and Balance after on Donations, Payouts and Transfers', () => {
    const page = readFileSync('src/pages/CampaignDetail.tsx', 'utf8');
    expect(page).toContain('const showStatement = canWork && !summary.data?.pool_id;');
    expect(page).toContain("...(showStatement ? ['statement' as Tab] : [])");
    expect(page).toContain("columns: [...donationColumns({ hideCampaign: family.length < 2 }), ...balanceCol('donation')],");
    expect(page.match(/\.\.\.balanceCol\('transfer'\)/g)).toHaveLength(2);
    expect(page).toContain("...balanceCol('payout'),");
  });
});
