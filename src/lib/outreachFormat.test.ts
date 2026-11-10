import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EMAIL_HELP, MERGE_FIELDS, SMS_HELP, smsPlain } from './outreachFormat';

// Moshe Henig, 2026-11-10: the New Template form says what formatting and merge fields work; texts can't show
// bold or italic, so their markers are taken out instead of arriving as stars.
describe('outreach formatting', () => {
  it('takes bold and italic markers out of texts, and leaves the rest', () => {
    expect(smsPlain('Hi {first_name}, **thank you** for *everything*! 5 * 3 = 15. https://oizer.trubase.org/give/1001'))
      .toBe('Hi {first_name}, thank you for everything! 5 * 3 = 15. https://oizer.trubase.org/give/1001');
  });

  it('says what works on the New Template form', () => {
    expect(EMAIL_HELP).toMatch(/\*\*bold\*\*.*\*italic\*.*links/);
    expect(SMS_HELP).toMatch(/plain/);
    expect(MERGE_FIELDS).toEqual(['{first_name}', '{last_name}', '{campaign_name}']);
    const src = readFileSync('src/pages/Outreach.tsx', 'utf8');
    const dialog = src.slice(src.indexOf('function TemplateDialog'));
    expect(dialog).toMatch(/\{EMAIL_HELP\}[^]*\{SMS_HELP\}[^]*first_name[^]*last_name[^]*campaign_name/);
  });

  it('matches the server: the database fills the same three fields and formats email the same way', () => {
    const sql = readFileSync('supabase/migrations/20261118000000_outreach.sql', 'utf8');
    for (const f of MERGE_FIELDS) expect(sql).toContain(`'${f}'`);
    expect(sql).toMatch(/<b>\\1<\/b>/);
    expect(sql).toMatch(/<i>\\2<\/i>/);
  });
});
