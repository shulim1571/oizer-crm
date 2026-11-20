import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = (...p: string[]) => readFileSync(join(__dirname, '..', ...p), 'utf8');

// Moshe Henig, 2026-11-12: the Ref# a voucher gets when it's logged shows on transactions tied to it.
describe('Voucher Ref# in the transaction lists', () => {
  it('is a column (shown by default), filterable, linking admins to the voucher', () => {
    const c = src('pages', 'donationColumns.tsx');
    expect(c).toContain("key: 'voucher_id', label: 'Voucher Ref#', width: 150, filter: { column: 'voucher_id', type: 'text' },");
    expect(c).toContain('<AdminLink to={`/donations/vouchers?open=${encodeURIComponent(r.voucher_id)}`}>{r.voucher_id}</AdminLink>');
    const block = c.slice(c.indexOf("key: 'voucher_id'"), c.indexOf("key: 'check_number'"));
    expect(block).not.toContain('optional: true');
  });
  it('opens the voucher from the link, and a Ref# typed in the search finds its transactions', () => {
    expect(src('pages', 'Vouchers.tsx')).toContain("new URLSearchParams(search).get('open')");
    expect(src('pages', 'Donations.tsx')).toContain('`voucher_id.eq.${text}`');
  });
});
