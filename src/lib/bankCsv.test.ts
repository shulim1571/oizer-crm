import { describe, expect, it } from 'vitest';
import { findHeader, guessMapping, parseAmount, parseDate, toLines } from './bankCsv';
import { parseCsv } from './sheets';

describe('reading bank amounts', () => {
  it('handles the usual ways banks write them', () => {
    expect(parseAmount('$1,234.56')).toBe(1234.56);
    expect(parseAmount('(12.00)')).toBe(-12);
    expect(parseAmount('-12')).toBe(-12);
    expect(parseAmount('12.00-')).toBe(-12);
    expect(parseAmount('45.10 DR')).toBe(-45.1);
    expect(parseAmount('45.10 CR')).toBe(45.1);
    expect(parseAmount('+.5')).toBe(0.5);
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('n/a')).toBeNull();
  });
});

describe('reading bank dates', () => {
  it('handles ISO, US, compact and written-out dates', () => {
    expect(parseDate('2026-10-01')).toBe('2026-10-01');
    expect(parseDate('10/01/2026')).toBe('2026-10-01');
    expect(parseDate('10/1/26')).toBe('2026-10-01');
    expect(parseDate('20261001')).toBe('2026-10-01');
    expect(parseDate('Oct 1, 2026')).toBe('2026-10-01');
    expect(parseDate('1 October 2026')).toBe('2026-10-01');
    expect(parseDate('10/01/2026 12:00:00 AM')).toBe('2026-10-01');
  });
  it('refuses dates that don\'t exist', () => {
    expect(parseDate('02/30/2026')).toBeNull();
    expect(parseDate('13/01/2026')).toBeNull();
    expect(parseDate('soon')).toBeNull();
  });
});

describe('a statement file', () => {
  it('skips the summary above the header and reads one signed amount column', () => {
    const grid = parseCsv([
      'Account,Operating ****6789',
      'Beginning balance,"1,000.00"',
      '',
      'Posting Date,Description,Amount,Type,Check or Slip #',
      '10/01/2026,DEPOSIT,"1,168.00",CREDIT,',
      '10/02/2026,CHECK 1001,-250.00,DEBIT,1001',
      '10/03/2026,ZERO ADJ,0.00,,',
      ',Ending balance,"1,918.00",,',
    ].join('\n'));
    const file = findHeader(grid);
    const map = guessMapping(file.headers);
    expect(map).toMatchObject({ date: 0, description: 1, amount: 2, debit: null, credit: null, checkNumber: 4 });
    expect(toLines(file, map)).toEqual({
      lines: [
        { date: '2026-10-01', amount: 1168, description: 'DEPOSIT', check_number: null, bank_ref: null },
        { date: '2026-10-02', amount: -250, description: 'CHECK 1001', check_number: '1001', bank_ref: null },
      ],
      problems: [],
      skippedZero: 1,
    });
  });

  it('reads separate debit and credit columns, and finds a check number in the description', () => {
    const file = findHeader(parseCsv('Date,Memo,Debit,Credit,Reference\n2026-10-05,Check #2044 cleared,75.00,,R1\n2026-10-06,Interest,,1.25,R2\nbad,x,1,,\n'));
    const map = guessMapping(file.headers);
    expect(map).toMatchObject({ amount: null, debit: 2, credit: 3, reference: 4 });
    const out = toLines(file, map);
    expect(out.lines).toEqual([
      { date: '2026-10-05', amount: -75, description: 'Check #2044 cleared', check_number: '2044', bank_ref: 'R1' },
      { date: '2026-10-06', amount: 1.25, description: 'Interest', check_number: null, bank_ref: 'R2' },
    ]);
    expect(out.problems).toEqual(['Row 4: can\'t read the date "bad"']);
  });

  it('can flip a bank that shows withdrawals as positive', () => {
    const file = findHeader(parseCsv('Date,Description,Amount\n10/01/2026,Wire out,500\n'));
    expect(toLines(file, { ...guessMapping(file.headers), flipSign: true }).lines[0].amount).toBe(-500);
  });

  it('says so when there is no header row', () => {
    expect(() => findHeader(parseCsv('a,b\n1,2\n'))).toThrow(/header row/);
  });
});
