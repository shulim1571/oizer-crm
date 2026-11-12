import { describe, expect, it } from 'vitest';
import { ADMIN, MANAGER_1, MANAGER_2, rows, seededDb } from './harness';

// Moshe Henig, 2026-11-11: fundraisers have the calendar, book for themselves, and see only bookings related to them.
// m1 runs 1001 and helps on 1003; m2 runs 1002 and 1003.
const DAY = '2099-04-02';
const book = async (db: Awaited<ReturnType<typeof seededDb>>, user: string, campaign: string) =>
  (await rows<{ id: string }>(db, user, `select public.request_machine($1, $2) as id`, [DAY, campaign]))[0].id;
const calendar = (db: Awaited<ReturnType<typeof seededDb>>, user: string) =>
  rows<{ id: string; campaign_id: string }>(db, user, `select id, campaign_id from public.machine_booking_list where booking_date = $1 order by campaign_id`, [DAY]);

describe('fundraiser calendar', () => {
  it('shows a fundraiser only their own bookings and their campaigns’, enforced by the database', async () => {
    const db = await seededDb();
    const mine = await book(db, MANAGER_1, '1001');
    const other = await book(db, MANAGER_2, '1002');
    expect((await calendar(db, MANAGER_1)).map(b => b.id)).toEqual([mine]);
    expect((await calendar(db, MANAGER_2)).map(b => b.id)).toEqual([other]);
    expect((await calendar(db, ADMIN)).map(b => b.id).sort()).toEqual([mine, other].sort());
    // Not even by asking for it directly.
    expect(await rows(db, MANAGER_1, `select 1 from public.machine_bookings where id = $1`, [other])).toEqual([]);
  });

  it('lets a fundraiser book for themselves, but not on a campaign they aren’t on', async () => {
    const db = await seededDb();
    const id = await book(db, MANAGER_1, '1001');
    expect((await rows<{ status: string }>(db, MANAGER_1, `select status from public.machine_booking_list where id = $1`, [id]))[0].status).toBeTruthy();
    await expect(book(db, MANAGER_1, '1002')).rejects.toThrow();
  });
});
