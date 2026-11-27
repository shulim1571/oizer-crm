import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, rows, seededDb } from './harness';

// Readiness #12 (2026-11-15): a voucher funding backdated to a day landed on the day before (midnight UTC is the
// evening before in New York), and money paths used current_date, the database's UTC date.
describe("money dates are the organization's dates", () => {
  let base: PGlite;
  let db: PGlite;
  beforeAll(async () => { base = await seededDb(); });
  beforeEach(async () => { db = await base.clone(); await db.query(`set timezone = 'UTC'`); });

  it('stamps a backdated voucher funding on that day in New York, at noon', async () => {
    const [{ id }] = await rows<{ id: string }>(db, ADMIN,
      `insert into public.vouchers (campaign_id, issuer, face_value, fee_type, fee_percent) values ('1003', 'Voucher — OJC Fund', 1000, 'percent', 5) returning id`);
    const [{ r }] = await rows<{ r: { donation_id: string } }>(db, ADMIN, `select public.add_voucher_funding($1, 100, '2026-11-10', null, null) r`, [id]);
    const [d] = await rows<{ day: string; at: string }>(db, ADMIN,
      `select (created_at at time zone 'America/New_York')::date::text as "day", to_char(created_at at time zone 'America/New_York', 'HH24:MI') as "at" from public.donations where id = $1`, [r.donation_id]);
    expect(d).toEqual({ day: '2026-11-10', at: '12:00' });
    // Funded "today" (organization time) is stamped now.
    const [{ r: now }] = await rows<{ r: { donation_id: string } }>(db, ADMIN, `select public.add_voucher_funding($1, 50, public.org_today(), null, null) r`, [id]);
    const [{ secs }] = await rows<{ secs: number }>(db, ADMIN, `select extract(epoch from now() - created_at)::int secs from public.donations where id = $1`, [now.donation_id]);
    expect(Math.abs(secs)).toBeLessThan(5);
  });

  it('leaves no function or view on the UTC date', async () => {
    const left = await db.query<{ name: string }>(`
      select p.proname name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prosrc ~* '\\ycurrent_date\\y' and p.proname <> 'org_today'
      union all
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'v' and pg_get_viewdef(c.oid) ~* '\\ycurrent_date\\y'`);
    expect(left.rows).toEqual([]);
    // Views keep running as the person asking (their row security applies).
    const opts = await db.query<{ o: string[] }>(`select reloptions o from pg_class where oid = 'public.campaign_summary'::regclass`);
    expect(opts.rows[0].o).toContain('security_invoker=true');
  });
});
