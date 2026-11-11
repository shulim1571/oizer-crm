import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { amountInFigures, amountInWords, buildCheckPdf, micrLine } from '../../src/lib/checkPdf';

describe('check amounts', () => {
  it('writes the amount out in words', () => {
    expect(amountInWords(500)).toBe('Five Hundred and 00/100');
    expect(amountInWords(1234.5)).toBe('One Thousand Two Hundred Thirty-Four and 50/100');
    expect(amountInWords(0.99)).toBe('Zero and 99/100');
    expect(amountInWords(2000017.01)).toBe('Two Million Seventeen and 01/100');
    expect(amountInWords(19.995)).toBe('Twenty and 00/100');
  });

  it('pads the figures so nothing can be added', () => {
    expect(amountInFigures(1234.5)).toBe('$1,234.50****');
    expect(amountInFigures(1000000)).toBe('$1,000,000.00**');
  });
});

describe('MICR line', () => {
  it('puts each field at its standard position from the right edge', () => {
    const line = micrLine(1001, '021000021', '123456789');
    const at = (p: number) => line.find(c => c.position === p)?.char;
    // The account number sits at the left of its field (14 to 32), one space from the routing number (Moshe Henig, 2026-11-11).
    expect(at(22)).toBe('C');          // on-us symbol ends the account field
    expect(at(23)).toBe('9');
    expect(at(31)).toBe('1');
    expect(at(32)).toBeUndefined();    // the one space before the routing number
    expect(at(33)).toBe('A');          // transit field, 33 to 43
    expect(at(34)).toBe('1');
    expect(at(43)).toBe('A');
    expect(at(45)).toBe('C');          // check number in the auxiliary on-us field
    expect(at(46)).toBe('1');
    expect(at(50)).toBe('C');
    expect(line.map(c => c.char).join('')).toBe('C1001CA021000021A123456789C');
  });

  it('uses the font\'s own symbol characters', () => {
    expect(micrLine(7, '021000021', '55', 'T', 'U').map(c => c.char).join('')).toBe('U7UT021000021T55U');
  });
});

describe('check PDF', () => {
  it('builds a one-page letter PDF', async () => {
    const bytes = await buildCheckPdf({
      checkNumber: 1001, date: '11/2/2026', payee: 'Acme Roofing', amount: 1234.5, memo: 'Roof', campaign: 'Building Fund',
      printName: 'Cong Oizer', printAddress: '1 Main St\nMonsey NY', bankName: 'JP Morgan Chase', routing: '021000021', account: '123456789',
      sample: true,
    });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getPage(0).getSize()).toEqual({ width: 612, height: 792 });
    expect(doc.getTitle()).toBe('Check 1001');
  });
});
