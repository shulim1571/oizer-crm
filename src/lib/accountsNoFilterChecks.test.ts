import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { accountFields } from './schemas';

// Moshe Henig, 2026-11-10: take the Filter Checks column and checkbox off the Bank Accounts screen entirely.
describe('Bank Accounts without Filter Checks', () => {
  it('is gone from the list, the account form and the account page', () => {
    expect(accountFields.map(f => f.name)).not.toContain('filter_checks');
    for (const f of ['src/pages/SimplePages.tsx', 'src/pages/Related.tsx', 'src/lib/schemas.ts']) {
      expect(readFileSync(f, 'utf8')).not.toMatch(/filter_checks|Filter Checks/i);
    }
  });
});
