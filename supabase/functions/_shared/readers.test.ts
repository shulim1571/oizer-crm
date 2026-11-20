import { describe, expect, it } from 'vitest';
import { detect, isoDate, readAbCharity, readChase, readOjcAch, readOjcSubmission, readPledgerAch, readPledgerBatch, rowsFromItems } from './readers';

// The inbox readers (2026-11-19). Every sample here is made up: no real donors, certificates, accounts or amounts.
const CHASE = `---------- Forwarded message ---------
From: Chase <no.reply.alerts@chase.com>
Subject: We received your check deposit

QuickDepositSM received
We received your check deposit
Account (...1234)
Received November 18, 2026 08:41 PM ET
Amount $412.50
Review account`;

const OJC_ACH = `ACH Deposit
An ACH deposit of $334.92 was sent to your account ending in 1234.
ACH id: 1700001
Trans. #  Amount  Redeemed On  Acct #  Donor Info  Plan B Charge  Card Number
1000000001  $36.00  11/18/2026  550001  Sample Donor  $1.08  ************4242
12345678  $100.00  11/18/2026  550002  $0.00
12345679  $200.00  11/18/2026  550003  $0.00
Total Amount: $336.00
Total Plan B Charges: $1.08
Total Transaction Fee: $0.00
Amount funded: $334.92`;

const OJC_SUB = `Certificates submission received
3 certificates, total $300.00
Batch No: 1700002
Reference: a1b2c3d4
Cert #  Acct #  Amount
12345680  550004  $100.00
12345681  550005  $200.00
Your batch will go through a review process (up to 2 business days).`;

describe('which reader fits', () => {
  it('goes by the trusted sender\'s report type, or by content for "other" senders', () => {
    expect(detect('ojc_ach', 'anything', '', false)).toBe('ojc_ach');
    expect(detect('zelle', 'We received your check deposit', 'Chase', false)).toBeNull();
    expect(detect('other', 'Fwd: We received your check deposit', CHASE, false)).toBe('bank_check_deposit');
    expect(detect('other', 'ACH Deposit', OJC_ACH, false)).toBe('ojc_ach');
    expect(detect('other', 'Certificates submission received', OJC_SUB, false)).toBe('ojc_submission');
    expect(detect('other', 'ACH Notification - 2026-11-18', '', true)).toBe('pledger_ach');
    expect(detect('other', 'Batch Submission Confirmation – Sample (#ab12cd)', '', true)).toBe('pledger_batch');
    expect(detect('other', 'Hello', 'nothing to see', false)).toBeNull();
  });
});

describe('readers', () => {
  it('reads an AB Charity payout as a total-only deposit (made-up values)', () => {
    const text = `AB Charity - Payouts Are On The Way\nOrganization Account #: 99999\nDate: 11/19/2026 3:15 PM\nGross Payout total: $1,250.00\nTo: Sample Bank account ending in 1234`;
    expect(detect('other', 'AB Charity - Payouts Are On The Way', text, false)).toBe('ab_charity');
    expect(readAbCharity(text)).toEqual({ kind: 'ab_charity', issuer: 'AB Charity', deposit_date: '2026-11-19', gross: 1250, net: 1250, account_last4: '1234', notes: null, lines: [] });
  });

  it('reads a Chase check-deposit notice (layout of the real one, made-up values)', () => {
    expect(readChase(CHASE)).toMatchObject({ kind: 'bank_check_deposit', issuer: 'Chase', deposit_date: '2026-11-18', net: 412.5, account_last4: '1234', notes: null, lines: [] });
    expect(readChase('Nothing useful').notes).toMatch(/amount.*date/);
  });

  it('reads an OJC ACH deposit: totals, certificate lines and a card line', () => {
    const d = readOjcAch(OJC_ACH);
    expect(d).toMatchObject({ kind: 'ojc_ach', issuer: 'OJC', issuer_ref: '1700001', gross: 336, fees: 1.08, net: 334.92, notes: null });
    expect(d.lines).toEqual([
      { kind: 'card', ref: '1000000001', amount: 36, fee: 1.08, line_date: '2026-11-18', card_last4: '4242', donor_account: '550001' },
      { kind: 'certificate', ref: '12345678', amount: 100, fee: 0, line_date: '2026-11-18', card_last4: null, donor_account: '550002' },
      { kind: 'certificate', ref: '12345679', amount: 200, fee: 0, line_date: '2026-11-18', card_last4: null, donor_account: '550003' },
    ]);
  });

  it('reads an OJC submission, noting a review', () => {
    const d = readOjcSubmission(OJC_SUB);
    expect(d).toMatchObject({ kind: 'ojc_submission', issuer_ref: '1700002' });
    expect(d.lines.map(l => [l.ref, l.amount, l.donor_account, l.cert_status])).toEqual([['12345680', 100, '550004', 'in_review'], ['12345681', 200, '550005', 'in_review']]);
    expect(d.notes).toMatch(/review/);
  });

  it('reads Pledger ACH and batch PDFs from their text rows', () => {
    const ach = readPledgerAch([
      'Voucher #  Method  Voucher Note  Trans Type  Date  Donor Name  Amount  Fee  Pay Amount  Campaign Ref',
      'V100001  Card (***4242)  Sample note  Donary  11/18/2026  Sample Donor  $50.00  $1.50  $48.50  1001',
      'V100002  Certificate    Org web scan  11/18/2026  Anonymous  $100.00  $0.00  $100.00',
      'Number of Transactions  2', 'Total Transaction Amounts  $150.00', 'Total Transaction Fees  $1.50', 'Total Pay Amount  $148.50',
    ], 'ACH Notification - 2026-11-19');
    expect(ach).toMatchObject({ kind: 'pledger_ach', deposit_date: '2026-11-19', gross: 150, fees: 1.5, net: 148.5, notes: null });
    expect(ach.lines).toEqual([
      { kind: 'card', ref: 'V100001', amount: 50, fee: 1.5, line_date: '2026-11-18', card_last4: '4242', trans_type: 'Donary', donor_name: 'Sample Donor' },
      { kind: 'certificate', ref: 'V100002', amount: 100, fee: 0, line_date: '2026-11-18', card_last4: null, trans_type: 'Org web scan', donor_name: null },
    ]);
    const batch = readPledgerBatch(['Batch Token  ab12cd', 'Gross Total  $300.00', 'Total Fees  $3.00', 'Net Payout  $297.00',
      'Certificate #  Amount  Status  Fee', 'PC0001  $100.00  Ready  $1.00', 'PC0002  $200.00  Pending  $2.00'], 'Batch Submission Confirmation – Sample (#ab12cd)');
    expect(batch).toMatchObject({ kind: 'pledger_batch', issuer_ref: 'ab12cd', gross: 300, fees: 3, net: 297 });
    expect(batch.lines.map(l => [l.ref, l.amount, l.fee, l.cert_status])).toEqual([['PC0001', 100, 1, 'ready'], ['PC0002', 200, 2, 'pending']]);
  });

  it('rebuilds PDF rows from text positions, and reads dates in their usual forms', () => {
    expect(rowsFromItems([{ str: '$50.00', x: 300, y: 700 }, { str: 'V1', x: 10, y: 700.5 }, { str: 'Total', x: 10, y: 650 }])).toEqual(['V1  $50.00', 'Total']);
    // Wrapped cells ("Card" above and "(***4242)" below a data row) go back into their cell.
    expect(rowsFromItems([
      { str: 'Card', x: 60, y: 708 }, { str: 'Sample', x: 300, y: 708 },
      { str: 'V1', x: 10, y: 700 }, { str: '11/18/2026', x: 200, y: 700 }, { str: '$50.00', x: 400, y: 700 },
      { str: '(***4242)', x: 61, y: 692 }, { str: 'Donor', x: 300, y: 692 },
    ])).toEqual(['V1  Card (***4242)  11/18/2026  Sample Donor  $50.00']);
    expect([isoDate('11/18/26'), isoDate('2026-1-5'), isoDate('Nov. 3, 2026'), isoDate('none')]).toEqual(['2026-11-18', '2026-01-05', '2026-11-03', null]);
  });
});
