import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, OIZER, rows, seededDb } from './harness';

// Moshe Henig, 2026-11-11: text lookups accept team and sub-campaign IDs, which end in a letter (1001A), any case.
const NUMBER = '+18456134272';
const STRANGER = '+12125550199';
const text = async (db: PGlite, body: string, from = STRANGER) =>
  (await rows<{ r: string | null }>(db, 'service_role', `select public.sms_lookup_reply($1, $2, $3) r`, [NUMBER, from, body]))[0].r;

describe('text lookup of lettered IDs', () => {
  let base: PGlite;
  let db: PGlite;
  let team: string;
  let nested: string;
  beforeAll(async () => {
    base = await seededDb();
    await base.exec(`
      update public.org_members set role = 'super_admin' where user_id = '${ADMIN}';
      insert into public.messaging_settings (org_id, sms_from) values ('${OIZER}', '${NUMBER}')
        on conflict (org_id) do update set sms_from = excluded.sms_from;
      update public.campaigns set pin = '4321' where id = '1002';
    `);
    await rows(base, ADMIN, `select public.save_phone_lookup(true, false)`);
    team = (await rows<{ id: string }>(base, ADMIN, `select public.add_sub_campaign('1002', 'Table 1', 'shared') id`))[0].id;
    nested = (await rows<{ id: string }>(base, ADMIN, `select public.add_sub_campaign($1, 'Sub table', 'shared') id`, [team]))[0].id;
    await base.query(`update public.campaigns set pin = '5678' where id in ($1, $2)`, [team, nested]);
  });
  beforeEach(async () => { db = await base.clone(); });

  it('answers a team ID with its PIN, in any case and spacing', async () => {
    expect(team).toBe('1002A');
    expect(await text(db, '1002A 5678')).toMatch(/^1002A Table 1: Raised \$/);
    expect(await text(db, '1002a 5678')).toMatch(/^1002A Table 1: Raised/);
    expect(await text(db, 'bal 1002A, 5678')).toMatch(/^1002A Table 1: Raised/);
    expect(await text(db, `${nested.toLowerCase()} 5678`)).toMatch(/^1002A-A Sub table: Raised/);
  });

  it('asks for the PIN, refuses a wrong one, and says when there is no such team', async () => {
    expect(await text(db, '1002A')).toBe('Text 1002A and its PIN, like: 1002A 1234');
    expect(await text(db, '1002A 1111')).toBe("That PIN doesn't match campaign 1002A. Check it and text: 1002A and the PIN");
    expect(await text(db, '1002Z 5678')).toMatch(/^No campaign with that number\./);
  });

  it('still reads number IDs as before', async () => {
    expect(await text(db, '1002 4321')).toMatch(/^1002 .*Raised/);
    expect(await text(db, '10024321')).toMatch(/^1002 .*Raised/);
  });

  it('takes a lettered ID after RECENT', async () => {
    const reply = await text(db, 'recent 1002a');
    expect(reply).not.toMatch(/Raised/);   // handled as RECENT, not as a balance lookup
  });
});
