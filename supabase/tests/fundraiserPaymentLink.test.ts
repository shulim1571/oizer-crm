import { describe, expect, it } from 'vitest';
import { ADMIN, OIZER, as, rows, seededDb } from './harness';

// Moshe Henig, 2026-11-11: each fundraiser has their own payment link, and outreach messages fill it in as {payment_link}.
describe('fundraiser payment links', () => {
  it('fill {payment_link}: a fundraiser’s own link, and a donor’s campaign’s primary fundraiser link', async () => {
    const db = await seededDb();
    await db.query(`insert into public.messaging_settings (org_id, live) values ($1, true)`, [OIZER]);
    await db.query(`update public.donors set email = 'donor1@example.org' where id = 'd1'`);
    await as(db, ADMIN, tx => tx.query(`update public.managers set payment_link = 'https://give.example.org/m1', email = 'm1@example.org' where id = 'm1'`));
    await as(db, ADMIN, tx => tx.query(`select public.send_outreach('email', 'Your link', 'Give here: {payment_link}', null, $1)`,
      [JSON.stringify([{ kind: 'fundraiser', id: 'm1' }, { kind: 'donor', id: 'd1', campaign_id: '1001' }])]));
    const sent = (await db.query<{ to_address: string; body: string }>(`select to_address, body from public.messages where kind = 'outreach' order by to_address`)).rows;
    // (Each message also ends with the unsubscribe link.)
    expect(sent.map(m => [m.to_address, m.body.split('\n')[0]])).toEqual([
      ['donor1@example.org', 'Give here: https://give.example.org/m1'],   // 1001's primary fundraiser is m1
      ['m1@example.org', 'Give here: https://give.example.org/m1'],
    ]);
  });

  it('accept only web addresses', async () => {
    const db = await seededDb();
    await expect(as(db, ADMIN, tx => tx.query(`update public.managers set payment_link = 'not a link' where id = 'm1'`))).rejects.toThrow();
    expect((await rows(db, ADMIN, `select 1 from public.managers where id = 'm1'`)).length).toBe(1);
  });
});
