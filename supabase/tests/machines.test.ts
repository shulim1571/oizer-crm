import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, MANAGER_1, MANAGER_2, as, rows, seededDb } from './harness';

const sql = (db: PGlite, q: string, params: unknown[] = [], user = ADMIN) => as(db, user, tx => tx.query(q, params));
const one = async <T = Record<string, any>>(db: PGlite, q: string, params: unknown[] = [], user = ADMIN) => (await rows<T>(db, user, q, params))[0];
const machine = async (db: PGlite, donaryId: string, nickname: number | null = null) =>
  (await one<{ id: string }>(db, `select public.register_machine($1, $2) as id`, [donaryId, nickname])).id;
const FUTURE = '2099-03-10';
const request = async (db: PGlite, campaign: string, user = MANAGER_1, date = FUTURE) =>
  (await one<{ id: string }>(db, `select public.request_machine($1, $2) as id`, [date, campaign], user)).id;
const status = async (db: PGlite, id: string) => (await one<{ status: string }>(db, `select status from public.machine_bookings where id = $1`, [id])).status;
const confirm = (db: PGlite, booking: string, m: string) => sql(db, `select public.confirm_booking($1, $2)`, [booking, m]);

describe('machine registry', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); });

  it('gives the next number that was never used', async () => {
    await machine(db, 'DP_1');
    const second = await machine(db, 'DP_2');
    expect((await one(db, `select nickname from public.machines where id = $1`, [second])).nickname).toBe(2);
    await sql(db, `select public.set_machine_active($1, false)`, [second]);
    const third = await machine(db, 'DP_3');
    expect((await one(db, `select nickname from public.machines where id = $1`, [third])).nickname).toBe(3);
  });

  it('never gives a used number to another machine, even after it is changed or retired', async () => {
    const a = await machine(db, 'DP_1');
    const b = await machine(db, 'DP_2');
    await expect(machine(db, 'DP_3', 2)).rejects.toThrow(/already been used/);
    await sql(db, `select public.update_machine($1, 7, 'DP_1')`, [a]);
    await expect(machine(db, 'DP_3', 1)).rejects.toThrow(/already been used/);
    await expect(sql(db, `select public.update_machine($1, 1, 'DP_2')`, [b])).rejects.toThrow(/already been used/);
    await sql(db, `select public.update_machine($1, 1, 'DP_1')`, [a]);
    expect((await one(db, `select nickname from public.machines where id = $1`, [a])).nickname).toBe(1);
    expect((await one<{ id: string }>(db, `select public.register_machine('DP_9') as id`)).id).toBeTruthy();
    expect((await one(db, `select nickname from public.machines where donary_id = 'DP_9'`)).nickname).toBe(8);
  });

  it('refuses the same Donary machine twice', async () => {
    await machine(db, 'DP_1');
    await expect(machine(db, 'dp_1')).rejects.toThrow(/already registered/);
  });

  it('records every assignment, and takes active campaigns only', async () => {
    const m = await machine(db, 'DP_1');
    await sql(db, `select public.assign_machine($1, '1001')`, [m]);
    await sql(db, `select public.assign_machine($1, '1002', 'For the dinner')`, [m]);
    await sql(db, `select public.assign_machine($1, '1002')`, [m]);
    const history = await rows<Record<string, any>>(db, ADMIN, `select from_campaign, to_campaign, note, changed_by from public.machine_assignments where machine_id = $1 order by changed_at`, [m]);
    expect(history.map(h => [h.from_campaign, h.to_campaign])).toEqual([[null, '1001'], ['1001', '1002']]);
    expect(history[1].note).toBe('For the dinner');
    expect(history[1].changed_by).toBeTruthy();
    await sql(db, `update public.campaigns set status = 'archived' where id = '1001'`);
    await expect(sql(db, `select public.assign_machine($1, '1001')`, [m])).rejects.toThrow(/active campaign/);
  });

  it('can go on a sub-campaign, and several machines can share a campaign', async () => {
    const a = await machine(db, 'DP_1');
    const b = await machine(db, 'DP_2');
    await sql(db, `insert into public.campaigns (id, internal_name, external_name, parent_campaign_id, status) values ('1001A', 'Sub', 'Sub', '1001', 'active')`);
    await sql(db, `select public.assign_machine($1, '1001A')`, [a]);
    await sql(db, `select public.assign_machine($1, '1001A')`, [b]);
    expect((await rows(db, ADMIN, `select id from public.machines where campaign_id = '1001A'`)).length).toBe(2);
  });

  it('keeps assignment history out of reach, even for admins', async () => {
    const m = await machine(db, 'DP_1');
    await sql(db, `select public.assign_machine($1, '1001')`, [m]);
    await expect(sql(db, `delete from public.machine_assignments`)).rejects.toThrow();
    await expect(sql(db, `update public.machine_assignments set to_campaign = '1002'`)).rejects.toThrow();
    await expect(sql(db, `update public.machines set campaign_id = '1002'`)).rejects.toThrow();
    await expect(sql(db, `delete from public.machines`)).rejects.toThrow();
  });

  it('retiring ends the assignment and is refused while bookings are coming up', async () => {
    const m = await machine(db, 'DP_1');
    await sql(db, `select public.assign_machine($1, '1001')`, [m]);
    const b = await request(db, '1001');
    await confirm(db, b, m);
    await expect(sql(db, `select public.set_machine_active($1, false)`, [m])).rejects.toThrow(/confirmed bookings/);
    await sql(db, `select public.cancel_booking($1)`, [b]);
    await sql(db, `select public.set_machine_active($1, false)`, [m]);
    const row = await one(db, `select active, campaign_id, retired_at from public.machines where id = $1`, [m]);
    expect(row).toMatchObject({ active: false, campaign_id: null });
    expect(row.retired_at).toBeTruthy();
    expect((await one(db, `select to_campaign, note from public.machine_assignments where machine_id = $1 order by changed_at desc limit 1`, [m]))).toMatchObject({ to_campaign: null, note: 'Machine retired' });
    await expect(sql(db, `select public.assign_machine($1, '1002')`, [m])).rejects.toThrow(/retired/);
    await expect(sql(db, `select public.update_machine($1, 5, 'DP_1')`, [m])).rejects.toThrow(/keeps its number/);
  });

  it('is for admins only, and fundraisers never see a Donary ID', async () => {
    const m = await machine(db, 'DP_1');
    await expect(rows(db, MANAGER_1, `select public.register_machine('DP_2')`)).rejects.toThrow();
    await expect(rows(db, MANAGER_1, `select public.assign_machine($1, '1001')`, [m])).rejects.toThrow();
    expect(await rows(db, MANAGER_1, `select * from public.machines`)).toEqual([]);
    expect(await rows(db, MANAGER_1, `select * from public.machine_assignments`)).toEqual([]);
    await expect(rows(db, 'anon', `select * from public.machines`)).rejects.toThrow();
  });
});

describe('machine booking', () => {
  let db: PGlite;
  let m1: string;
  let m2: string;
  beforeEach(async () => {
    db = await seededDb();
    m1 = await machine(db, 'DP_1');
    m2 = await machine(db, 'DP_2');
  });
  const avail = (user = MANAGER_1) => one(db, `select * from public.machine_availability($1, $1)`, [FUTURE], user);

  it('takes requests from fundraisers for their own campaigns and shows them counts', async () => {
    expect(await avail()).toMatchObject({ machines: 2, booked: 0, waitlisted: 0, available: 2 });
    const b = await request(db, '1001');
    expect(await status(db, b)).toBe('pending');
    expect(await avail(MANAGER_2)).toMatchObject({ machines: 2, booked: 1, available: 1 });
    await expect(request(db, '1002')).rejects.toThrow(/isn't yours/);
    await expect(rows(db, 'anon', `select * from public.machine_availability('2099-01-01', '2099-01-02')`)).rejects.toThrow();
  });

  it('does not take past dates, but today counts where the organization is', async () => {
    await expect(request(db, '1001', MANAGER_1, '2020-01-01')).rejects.toThrow(/later date/);
    const today = (await one<{ d: string }>(db, `select public.org_today()::text as d`)).d;
    expect(await status(db, await request(db, '1001', MANAGER_1, today))).toBe('pending');
  });

  it('shows fundraisers their own requests and place in line, not anyone else\'s', async () => {
    const first = await request(db, '1002', MANAGER_2);
    const mine = await request(db, '1001');
    const list = await rows<Record<string, any>>(db, MANAGER_1, `select * from public.machine_booking_list`);
    expect(list.map(r => r.id)).toEqual([mine]);
    expect(list[0].queue_position).toBe(2);
    expect((await rows(db, ADMIN, `select id from public.machine_booking_list`)).map((r: any) => r.id).sort()).toEqual([first, mine].sort());
  });

  it('gives the number of the machine to the fundraiser once confirmed', async () => {
    const b = await request(db, '1001');
    await sql(db, `select public.confirm_booking($1, $2, 'Bring it back by 6pm')`, [b, m2]);
    const row = await one(db, `select status, machine_nickname, admin_notes, past from public.machine_booking_list where id = $1`, [b], MANAGER_1);
    expect(row).toMatchObject({ status: 'confirmed', machine_nickname: 2, admin_notes: 'Bring it back by 6pm', past: false });
  });

  it('waits its turn: the earliest request is confirmed first', async () => {
    const first = await request(db, '1001');
    const second = await request(db, '1002', MANAGER_2);
    await expect(confirm(db, second, m1)).rejects.toThrow(/earlier request/);
    await confirm(db, first, m1);
    await confirm(db, second, m2);
    expect(await status(db, second)).toBe('confirmed');
  });

  it('does not give the same machine twice in a day', async () => {
    const first = await request(db, '1001');
    const second = await request(db, '1002', MANAGER_2);
    await confirm(db, first, m1);
    await expect(confirm(db, second, m1)).rejects.toThrow(/already taken/);
    const other = await request(db, '1001', MANAGER_1, '2099-03-11');
    await confirm(db, other, m1);
    expect(await status(db, other)).toBe('confirmed');
  });

  it('waitlists requests past the number of machines, on request or once all are assigned', async () => {
    const a = await request(db, '1001');
    const b = await request(db, '1002', MANAGER_2);
    const c = await request(db, '1001');
    expect(await status(db, c)).toBe('waitlisted');
    expect(await avail()).toMatchObject({ booked: 2, waitlisted: 1, available: 0 });
    await sql(db, `select public.set_machine_active($1, false)`, [m2]);
    await confirm(db, a, m1);
    expect(await status(db, b)).toBe('waitlisted');
  });

  it('a cancellation sends the next waitlisted request back to be offered the machine', async () => {
    const a = await request(db, '1001');
    const b = await request(db, '1002', MANAGER_2);
    const c = await request(db, '1001');
    const d = await request(db, '1002', MANAGER_2);
    await confirm(db, a, m1);
    await sql(db, `select public.cancel_booking($1, 'Dinner moved')`, [a], MANAGER_1);
    expect(await status(db, a)).toBe('cancelled');
    expect(await status(db, c)).toBe('pending');
    expect(await status(db, d)).toBe('waitlisted');
    expect((await one(db, `select cancelled_by, cancel_reason, machine_id from public.machine_bookings where id = $1`, [a])).cancel_reason).toBe('Dinner moved');
    const task = await one(db, `select task_type, summary from public.admin_task_sheet where record_id = $1`, [c]);
    expect(task.summary).toMatch(/opened up/);
    expect(await status(db, b)).toBe('pending');
  });

  it('lets a waitlisted request take a machine once one is free', async () => {
    const a = await request(db, '1001');
    const b = await request(db, '1002', MANAGER_2);
    const c = await request(db, '1001');
    await sql(db, `select public.register_machine('DP_3')`);
    await confirm(db, a, m1);
    await confirm(db, b, m2);
    const third = (await one<{ id: string }>(db, `select id from public.machines where donary_id = 'DP_3'`)).id;
    await confirm(db, c, third);
    expect(await status(db, c)).toBe('confirmed');
  });

  it('only the requester\'s side or an admin can cancel', async () => {
    const a = await request(db, '1001');
    await expect(sql(db, `select public.cancel_booking($1)`, [a], MANAGER_2)).rejects.toThrow(/isn't yours/);
    await sql(db, `select public.cancel_booking($1)`, [a]);
    await expect(sql(db, `select public.cancel_booking($1)`, [a])).rejects.toThrow(/already cancelled/);
  });

  it('an admin can change the order, with a reason, and requested_at stays', async () => {
    const a = await request(db, '1001');
    const b = await request(db, '1002', MANAGER_2);
    const before = await one(db, `select requested_at from public.machine_bookings where id = $1`, [b]);
    await expect(sql(db, `select public.move_booking($1, true, '')`, [b])).rejects.toThrow(/reason/);
    await expect(sql(db, `select public.move_booking($1, true, 'x')`, [b], MANAGER_2)).rejects.toThrow();
    await expect(sql(db, `select public.move_booking($1, true, 'x')`, [a])).rejects.toThrow(/already first/);
    await sql(db, `select public.move_booking($1, true, 'Yahrzeit event')`, [b]);
    await confirm(db, b, m1);
    const row = await one(db, `select requested_at, priority_note from public.machine_bookings where id = $1`, [b]);
    expect(row.requested_at).toEqual(before.requested_at);
    expect(row.priority_note).toBe('Yahrzeit event');
    expect((await one(db, `select queue_position from public.machine_booking_list where id = $1`, [a])).queue_position).toBe(2);
    const log = await rows(db, ADMIN, `select 1 from public.activity_log where table_name = 'machine_bookings' and record_id = $1 and changes::text like '%Yahrzeit event%'`, [b]);
    expect(log.length).toBeGreaterThan(0);
  });

  it('cannot be written to directly', async () => {
    const a = await request(db, '1001');
    await expect(sql(db, `update public.machine_bookings set status = 'confirmed' where id = $1`, [a], MANAGER_1)).rejects.toThrow();
    await expect(sql(db, `delete from public.machine_bookings where id = $1`, [a])).rejects.toThrow();
  });

  it('leaves the Task Sheet once confirmed or waitlisted', async () => {
    const a = await request(db, '1001');
    expect((await rows(db, ADMIN, `select 1 from public.admin_task_sheet where record_id = $1 and task_type = 'machine_booking'`, [a])).length).toBe(1);
    await confirm(db, a, m1);
    expect((await rows(db, ADMIN, `select 1 from public.admin_task_sheet where record_id = $1`, [a])).length).toBe(0);
  });

  it('keeps organizations apart', async () => {
    const OTHER = '00000000-0000-4000-8000-0000000000bb';
    const OTHER_ADMIN = '00000000-0000-0000-0000-0000000000b1';
    await db.exec(`
      insert into public.organizations (id, slug, name) values ('${OTHER}', 'other', 'Other Org');
      insert into auth.users (id, email) values ('${OTHER_ADMIN}', 'admin@other.org');
      insert into public.org_members (org_id, user_id, role) values ('${OTHER}', '${OTHER_ADMIN}', 'super_admin');
      insert into public.campaigns (org_id, id, internal_name, external_name, status) values ('${OTHER}', '1001', 'Theirs', 'Theirs', 'active');
    `);
    const a = await request(db, '1001');
    expect(await rows(db, OTHER_ADMIN, `select id from public.machines`)).toEqual([]);
    expect(await rows(db, OTHER_ADMIN, `select id from public.machine_booking_list`)).toEqual([]);
    // Numbers and Donary IDs are each organization's own.
    const theirs = (await one<{ id: string }>(db, `select public.register_machine('DP_1', 1) as id`, [], OTHER_ADMIN)).id;
    await expect(sql(db, `select public.confirm_booking($1, $2)`, [a, theirs], OTHER_ADMIN)).rejects.toThrow(/not found/);
    await expect(confirm(db, a, theirs)).rejects.toThrow(/Choose a machine/);
    expect(await one(db, `select available from public.machine_availability($1, $1)`, [FUTURE], OTHER_ADMIN)).toMatchObject({ available: 1 });
  });
});
