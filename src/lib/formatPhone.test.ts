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

// Moshe Henig, 2026-11-16 11:55 AM: "You didn't fix it for donors that have 2 phone numbers."
describe('two phone numbers in one field', () => {
  it('writes each one with dashes, keeping the separators and labels', () => {
    expect(formatPhone('8455551234 / 7185559876')).toBe('845-555-1234 / 718-555-9876');
    expect(formatPhone('(845) 555-1234, (718) 555-9876')).toBe('845-555-1234, 718-555-9876');
    expect(formatPhone('845.555.1234 or 718 555 9876')).toBe('845-555-1234 or 718-555-9876');
    expect(formatPhone('Home: 8455551234 Cell: 7185559876')).toBe('Home: 845-555-1234 Cell: 718-555-9876');
    expect(formatPhone('H 845-555-1234; C 718-555-9876 x22')).toBe('H 845-555-1234; C 718-555-9876 x22');
    expect(formatPhone('8455551234\n7185559876')).toBe('845-555-1234\n718-555-9876');
    expect(formatPhone('8455551234 7185559876')).toBe('845-555-1234 718-555-9876');
    expect(formatPhone('+1 845 555 1234 & 1-718-555-9876')).toBe('845-555-1234 & 718-555-9876');
  });

  it('splits two numbers run together with nothing between them', () => {
    expect(formatPhone('84555512347185559876')).toBe('845-555-1234 · 718-555-9876');
  });

  it('still leaves a number from abroad as it is, next to a US one', () => {
    expect(formatPhone('845 555 1234 / +972 52-123-4567')).toBe('845-555-1234 / +972 52-123-4567');
  });
});
