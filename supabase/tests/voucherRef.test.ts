import { describe, expect, it } from 'vitest';
import { ADMIN, rows, seededDb } from './harness';

// The voucher form shows our ref # once saved and keeps the issuer's ref. # separately (Moshe Henig, 2026-11-11).
describe('voucher reference numbers', () => {
  it('give each voucher a ref # on saving and keep the issuer ref. # apart from the issuer batch #', async () => {
    const db = await seededDb();
    const [v] = await rows<{ id: string; issuer_number: string; issuer_reference: string }>(db, ADMIN,
      `insert into public.vouchers (campaign_id, issuer, issuer_number, issuer_reference, face_value, fee_type)
       values ('1003', 'Voucher — OJC Fund', 'B-12', 'OJC-778899', 100, 'none') returning id, issuer_number, issuer_reference`);
    expect(v.id).toMatch(/^VCH-\d{4}-\d+$/);
    expect(v).toMatchObject({ issuer_number: 'B-12', issuer_reference: 'OJC-778899' });
    expect((await rows(db, ADMIN, `select id, issuer_reference, status from public.voucher_list where id = $1`, [v.id]))[0])
      .toEqual({ id: v.id, issuer_reference: 'OJC-778899', status: 'pending' });
  });
});
