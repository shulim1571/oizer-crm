import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Moshe Henig, 2026-11-15: no fundraiser-level receipt text on the fundraiser page; receipts use the organization's.
describe('fundraiser page', () => {
  it('has no receipt text section', () => {
    const page = readFileSync('src/pages/Related.tsx', 'utf8');
    expect(page).not.toContain("Receipt text for this fundraiser's campaigns");
    expect(page).not.toContain('ReceiptTextCard');
    expect(readFileSync('src/pages/Receipts.tsx', 'utf8')).toContain("'Used on every receipt. A section left empty is left off the receipt.'");
  });
});
