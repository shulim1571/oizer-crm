import { describe, expect, it } from 'vitest';
import { formatUsAddress, parseUsAddress } from './usAddress';

// Reading and writing addresses in the one-field layout (moved from the USPS check, removed 2026-11-25). Sample addresses only.
describe('US address helpers', () => {
  it('splits a two-line address', () => {
    expect(parseUsAddress('123 Sample St Apt 4\nBrooklyn, NY 11219')).toEqual({ streetAddress: '123 Sample St', secondaryAddress: 'Apt 4', city: 'Brooklyn', state: 'NY', ZIPCode: '11219' });
  });
  it('splits a one-line address with commas and a ZIP+4', () => {
    expect(parseUsAddress('45 Example Ave, Suite 200, Monsey, NY 10952-1234')).toEqual({ streetAddress: '45 Example Ave', secondaryAddress: 'Suite 200', city: 'Monsey', state: 'NY', ZIPCode: '10952', ZIPPlus4: '1234' });
  });
  it('handles city on its own line and lower-case state', () => {
    expect(parseUsAddress('9 Test Rd\nLakewood\nnj 08701')).toEqual({ streetAddress: '9 Test Rd', city: 'Lakewood', state: 'NJ', ZIPCode: '08701' });
  });
  it('takes a PO box, and a street with ZIP only', () => {
    expect(parseUsAddress('PO Box 12\nSpring Valley NY 10977')?.streetAddress).toBe('PO Box 12');
    expect(parseUsAddress('1 Demo Way, 10001')).toEqual({ streetAddress: '1 Demo Way', ZIPCode: '10001' });
  });
  it('gives up rather than guess', () => {
    for (const bad of ['', 'Brooklyn, NY', 'Sample Street, Brooklyn NY 11219', '123 Sample St']) expect(parseUsAddress(bad)).toBeNull();
  });
  it('writes an address in the field layout', () => {
    const a = { streetAddress: '123 Sample St', secondaryAddress: 'Apt 4', city: 'Brooklyn', state: 'NY', ZIPCode: '11219', ZIPPlus4: '3704' };
    expect(formatUsAddress(a)).toBe('123 Sample St Apt 4\nBrooklyn NY 11219-3704');
    expect(formatUsAddress(a, true)).toBe('123 Sample St Apt 4, Brooklyn NY 11219-3704');
  });
});
