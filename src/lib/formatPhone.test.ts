import { describe, expect, it } from 'vitest';
import { formatPhone } from './format';

// Moshe Henig, 2026-11-16: phone numbers with dashes, easier to read.
describe('phone numbers with dashes', () => {
  it('writes a US number as 845-555-1234, however it was typed', () => {
    for (const p of ['8455551234', '(845) 555-1234', '845.555.1234', '845 555 1234', '+1 845 555 1234', '1-845-555-1234', '845-555-1234']) {
      expect(formatPhone(p)).toBe('845-555-1234');
    }
  });
  it('keeps an extension, and writes 7 digits as 555-1234', () => {
    expect(formatPhone('(845) 555-1234 ext. 12')).toBe('845-555-1234 x12');
    expect(formatPhone('8455551234x7')).toBe('845-555-1234 x7');
    expect(formatPhone('5551234')).toBe('555-1234');
  });
  it('leaves numbers from abroad, odd lengths and empty values as they are', () => {
    expect(formatPhone('+972 52-123-4567')).toBe('+972 52-123-4567');
    expect(formatPhone('12345')).toBe('12345');
    expect(formatPhone(null)).toBe('');
    expect(formatPhone('  ')).toBe('');
  });
});
