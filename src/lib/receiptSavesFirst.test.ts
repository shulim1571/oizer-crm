import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Moshe Henig, 2026-11-11: "Issue receipt" on an open donation saves the form first, then issues the receipt.
describe('Issue receipt on an open donation', () => {
  it('saves the form first and only opens the receipt when the save worked', () => {
    const form = readFileSync('src/components/RecordForm.tsx', 'utf8');
    expect(form).toContain('<ReceiptActions donationId={p.record!.id} beforeIssue={async () => !!(await persist())} />');
    expect(form).toContain('async function persist(): Promise<Row | null>');
    const receipts = readFileSync('src/pages/Receipts.tsx', 'utf8');
    expect(receipts).toContain('onClick={async () => { if (!beforeIssue || await beforeIssue()) setIssuing(true); }}');
  });
});
