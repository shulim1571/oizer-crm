import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Moshe Henig, 2026-11-11: Recurring, Pledges, Vouchers and Receipts become tabs inside Transactions, the way
// Campaign Requests became a tab inside Campaigns.
const layout = readFileSync('src/components/Layout.tsx', 'utf8');
const app = readFileSync('src/App.tsx', 'utf8');

describe('Transactions tabs', () => {
  it('shows the four views as tabs of Transactions, with Vouchers and Receipts for admins only', () => {
    expect(layout).toMatch(/\{ to: '\/donations\/all', label: 'Transactions', icon: <CircleDollarSign size=\{I\} \/>,\s*tabs: \[\{ to: '\/donations\/all', label: 'Transactions' \}, \{ to: '\/donations\/recurring', label: 'Recurring' \},\s*\{ to: '\/donations\/pledges', label: 'Pledges' \}, \{ to: '\/donations\/vouchers', label: 'Vouchers', admin: true \},\s*\{ to: '\/donations\/receipts', label: 'Receipts', admin: true \}\] \},/);
    for (const old of ["to: '/recurring'", "to: '/pledges'", "to: '/vouchers'", "to: '/receipts'"]) expect(layout).not.toContain(old);
  });

  it('serves each view at its new address, admin-only where it was before', () => {
    expect(app).toContain('<Route path="donations/recurring" element={<RecurringPage />} />');
    expect(app).toContain('<Route path="donations/pledges" element={<PledgesPage />} />');
    expect(app).toContain('<Route path="donations/vouchers" element={<AdminOnly><VouchersPage /></AdminOnly>} />');
    expect(app).toContain('<Route path="donations/receipts" element={<AdminOnly><ReceiptsPage /></AdminOnly>} />');
  });

  it('keeps old links and emails working by redirecting them', () => {
    for (const v of ['recurring', 'pledges', 'vouchers', 'receipts']) {
      expect(app).toContain(`<Route path="${v}" element={<Navigate to="/donations/${v}" replace />} />`);
    }
    expect(readFileSync('src/pages/Dashboard.tsx', 'utf8')).toContain('to="/donations/pledges"');
  });
});
