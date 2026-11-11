import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// New Donation's tabs: one donation, a new pledge or new vouchers; Batch Entry is gone from here (Moshe Henig, 2026-11-11).
const src = (...p: string[]) => readFileSync(join(__dirname, '..', ...p), 'utf8');
const layout = src('components', 'Layout.tsx');
const app = src('App.tsx');
const entry = layout.slice(layout.indexOf("label: 'New Donation'"), layout.indexOf("label: 'Transactions'"));

describe('New Donation tabs', () => {
  it('offer one donation, a new pledge and new vouchers, not Batch Entry', () => {
    expect([...entry.matchAll(/\{ to: '([^']+)', label: '([^']+)' \}/g)].map(m => `${m[1]} ${m[2]}`)).toEqual([
      '/donations/new One donation', '/donations/pledges/new New pledge', '/donations/vouchers/new New vouchers',
    ]);
    expect(entry).not.toContain('/donations/batch');
  });

  it('open the pledge and voucher forms straight away, for admins', () => {
    expect(app).toContain('<Route path="donations/pledges/new" element={<AdminOnly><PledgesPage startNew /></AdminOnly>} />');
    expect(app).toContain('<Route path="donations/vouchers/new" element={<AdminOnly><VouchersPage startNew /></AdminOnly>} />');
    expect(src('pages', 'Pledges.tsx')).toContain("useState<'one' | 'recurring' | null>(startOpen ? 'one' : null)");
    expect(src('pages', 'Vouchers.tsx')).toContain('useState(!!startOpen)');
  });
});
