import { describe, expect, it } from 'vitest';
import { ADMIN, as, rows, seededDb } from './harness';

// Moshe Henig, 2026-11-11: a donor picked on an open donation is saved before the receipt is issued, so the receipt
// carries that donor.
describe('receipt after a donor is added to a donation', () => {
  it('names the donor that was just saved on the donation', async () => {
    const db = await seededDb();
    const [d] = await rows<{ id: string }>(db, ADMIN,
      `insert into public.donations (campaign_id, amount, type, status, payment_method) values ('1001', 50, 'Payment', 'completed', 'Cash') returning id`);
    await as(db, ADMIN, tx => tx.query(`update public.donations set donor_id = 'd1' where id = $1`, [d.id]));
    const [r] = await rows<{ id: string }>(db, ADMIN, `select public.issue_receipt($1) as id`, [d.id]);
    expect((await rows(db, ADMIN, `select donor_id from public.receipts where id = $1`, [r.id]))[0]).toEqual({ donor_id: 'd1' });
  });
});
