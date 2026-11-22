import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, MANAGER_1, OIZER, rows, seededDb } from './harness';

// Receipt wording (Shulim, 2026-11-22): the organization's default, overridden per campaign (over a fundraiser's).
// Oizer's default is the wording on Moshe's design. Sample data only.
const q = <T = Record<string, any>>(db: PGlite, sql: string, params: unknown[] = [], who = ADMIN) => rows<T>(db, who, sql, params, OIZER);
const text = async (db: PGlite, campaign: string) => (await q(db, `select * from public.receipt_text($1)`, [campaign]))[0];

describe('receipt wording by campaign', () => {
  let base: PGlite;
  let db: PGlite;
  beforeAll(async () => { base = await seededDb(); });
  beforeEach(async () => { db = await base.clone(); });

  it("starts from Moshe's wording as the default, with its blanks", async () => {
    const t = await text(db, '1001');
    expect(t.hebrew_salutation).toBe('לכבוד ידידנו\n**מו"ה {hebrew_name} הי"ו**');
    expect(t.hebrew_text).toContain('הננו בזה לאשר על קבלת נדבת לבו בסך {amount}');
    expect(t.hebrew_text).toContain('לטובת המגבית עבור {campaign}');
    expect(t.english_text).toMatch(/^\*\*Dear\*\* \{name\},\nThis is to acknowledge receipt of your generous contribution in the sum of \{amount\}/);
  });

  it('lets a campaign override parts of it; an empty part falls back, and clearing returns to the default', async () => {
    await q(db, `select public.save_receipt_template('campaign', '1001', null, null, $1)`, ['**Dear** {name}, thank you for the sample campaign.']);
    const t = await text(db, '1001');
    expect(t.english_text).toBe('**Dear** {name}, thank you for the sample campaign.');
    expect(t.hebrew_text).toContain('לטובת המגבית עבור {campaign}');          // from the default
    expect((await text(db, '1002')).english_text).toMatch(/^\*\*Dear\*\* \{name\},\nThis is to acknowledge/);   // other campaigns unchanged
    await q(db, `select public.save_receipt_template('campaign', '1001', null, null, null)`);
    expect((await text(db, '1001')).english_text).toMatch(/^\*\*Dear\*\*/);
  });

  it('puts campaign text above a fundraiser\'s, and keeps changes to admins', async () => {
    const [{ m }] = await q<{ m: string }>(db, `select manager_id m from public.campaigns where id = '1001'`);
    await q(db, `select public.save_receipt_template('fundraiser', $1, 'Fundraiser salutation', null, null)`, [m]);
    expect((await text(db, '1001')).hebrew_salutation).toBe('Fundraiser salutation');
    await q(db, `select public.save_receipt_template('campaign', '1001', 'Campaign salutation', null, null)`);
    expect((await text(db, '1001')).hebrew_salutation).toBe('Campaign salutation');
    await expect(q(db, `select public.save_receipt_template('campaign', '1001', 'x', null, null)`, [], MANAGER_1)).rejects.toThrow(/Only admins/);
    await expect(q(db, `select public.save_receipt_template('campaign', 'no-such', 'x', null, null)`)).rejects.toThrow(/Campaign not found/);
  });
});
