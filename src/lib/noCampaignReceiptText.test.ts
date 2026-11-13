import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Moshe Henig, 2026-11-11: campaigns no longer have their own receipt text; the standard text is used.
describe('no campaign receipt text', () => {
  it('is gone from the campaign settings', () => {
    expect(readFileSync('src/pages/Templates.tsx', 'utf8')).not.toMatch(/ReceiptTextCard|Receipt text for this campaign/);
  });
  it('can only be set for the organization (standard) or a fundraiser', () => {
    expect(readFileSync('src/pages/Receipts.tsx', 'utf8')).toContain("level: 'default' | 'fundraiser'; refId: string; title: string");
    expect(readFileSync('supabase/migrations/20261220000000_no_campaign_receipt_text.sql', 'utf8'))
      .toMatch(/check \(level in \('default', 'fundraiser'\)\)/);
  });
});
