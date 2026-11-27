import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, OIZER, rows, seededDb } from './harness';

// Moshe #11 (2026-11-15): Total potential keeps its formula; a team's raised, open pledges, pending and undelivered
// checks count on the parent just like the parent's own.
const q = <T = Record<string, any>>(db: PGlite, sql: string) => rows<T>(db, ADMIN, sql, [], OIZER);
const cols = `raised, combined_raised, pledged_open, combined_pledged_open, pending_balance, combined_pending,
              undelivered_checks_amount, combined_undelivered_checks`;

describe('Total potential includes teams', () => {
  let base: PGlite;
  let db: PGlite;
  beforeAll(async () => { base = await seededDb(); });
  beforeEach(async () => { db = await base.clone(); });

  it("adds a team's pledges and undelivered checks to the parent's combined figures", async () => {
    const [before] = await q(db, `select ${cols} from public.campaign_summary where id = '1003'`);
    await db.query(`insert into public.campaigns (org_id, id, internal_name, status, parent_campaign_id, balance_mode) values ($1, 'T44', 'Team', 'active', '1003', 'shared')`, [OIZER]);
    await db.query(`insert into public.donations (org_id, id, campaign_id, type, status, amount, fee, payment_method) values ($1, 'tp-pay', 'T44', 'Payment', 'completed', 100, 0, 'Cash')`, [OIZER]);
    await db.query(`insert into public.donations (org_id, id, campaign_id, type, status, amount, fee, payment_method, delivered) values ($1, 'tp-und', 'T44', 'Payment', 'completed', 400, 0, 'Check', false)`, [OIZER]);
    await db.query(`insert into public.pledges (org_id, campaign_id, amount, name) values ($1, 'T44', 250, 'Team pledge')`, [OIZER]);
    const [after] = await q(db, `select ${cols} from public.campaign_summary where id = '1003'`);
    const d = (k: string) => Number(after[k] ?? 0) - Number(before[k] ?? 0);
    expect(d('combined_raised')).toBe(100);
    expect(d('combined_pledged_open')).toBe(250);
    expect(d('combined_undelivered_checks')).toBe(400);
    expect(d('combined_pending')).toBe(0);
    // The parent's own figures don't change.
    expect(d('raised')).toBe(0);
    expect(d('pledged_open')).toBe(0);
    expect(d('undelivered_checks_amount')).toBe(0);
    const [team] = await q(db, `select ${cols} from public.campaign_summary where id = 'T44'`);
    expect(Number(team.combined_pledged_open)).toBe(250);   // a team on its own page: its own amounts
  });
});
