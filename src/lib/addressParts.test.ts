import { describe, expect, it } from 'vitest';
import { joinAddress, splitAddress } from './addressParts';

// Moshe Henig, 2026-11-12: donor addresses are edited in boxes and kept as one address field. Sample addresses only.
describe('donor address boxes', () => {
  it('splits a stored address into the boxes and joins it back the same way', () => {
    const a = splitAddress('123 Sample St Apt 4\nBrooklyn, NY 11219');
    expect(a).toEqual({ street: '123 Sample St', unit: 'Apt 4', city: 'Brooklyn', state: 'NY', zip: '11219' });
    expect(joinAddress(a)).toBe('123 Sample St Apt 4\nBrooklyn NY 11219');
  });
  it('keeps a ZIP+4 and upper-cases the state', () => {
    expect(joinAddress({ street: '9 Test Rd', unit: '', city: 'Lakewood', state: 'nj', zip: '08701-1234' })).toBe('9 Test Rd\nLakewood NJ 08701-1234');
  });
  it("puts an address it can't read into Street as it is, so nothing is lost", () => {
    expect(splitAddress('Rechov Sample 5, Jerusalem')).toEqual({ street: 'Rechov Sample 5, Jerusalem', unit: '', city: '', state: '', zip: '' });
    expect(splitAddress(null).street).toBe('');
  });
  it('an empty form saves an empty address', () => {
    expect(joinAddress({ street: '', unit: '', city: '', state: '', zip: '' })).toBe('');
  });
});
