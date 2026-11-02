// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { headerKey, parseCsv, parseXlsx, sheetValue, toXlsx } from '../../src/lib/sheets';

describe('spreadsheets', () => {
  it('reads CSV with quotes, commas and line breaks inside fields', () => {
    expect(parseCsv('﻿Name,Notes\r\n"Klein, Moshe","said ""hi""\nthen left"\n\n,\nGold,ok')).toEqual([
      ['Name', 'Notes'], ['Klein, Moshe', 'said "hi"\nthen left'], ['Gold', 'ok'],
    ]);
  });

  it('writes an .xlsx that reads back the same, with numbers as numbers', () => {
    const cols = [{ key: 'name', label: 'Name' }, { key: 'amount', label: 'Amount' }, { key: 'he', label: 'Hebrew' }];
    const bytes = toXlsx([{ name: 'A & B <x>', amount: 1234.5, he: 'משה' }, { name: 'C', amount: null, he: '' }], cols);
    expect(parseXlsx(bytes)).toEqual([['Name', 'Amount', 'Hebrew'], ['A & B <x>', '1234.5', 'משה'], ['C']]);
  });

  it('matches headers however they are written', () => {
    expect(headerKey(' First Name ')).toBe('first_name');
    expect(headerKey('Campaign ID')).toBe('campaign_id');
    expect(headerKey('State/Province')).toBe('state_province');
  });

  it('turns money text into numbers for Excel', () => {
    expect(sheetValue('$1,234.50')).toBe(1234.5);
    expect(sheetValue('1001')).toBe(1001);
    expect(sheetValue('Nov 1, 2026 · 3:03 PM')).toBe('Nov 1, 2026 · 3:03 PM');
  });
});
