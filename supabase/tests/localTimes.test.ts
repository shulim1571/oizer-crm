import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OIZER, seededDb } from './harness';

// Moshe Henig, 2026-11-15: Donary and Sola send New York times with no zone; they were stored as UTC (5 hours early).
const val = async (db: PGlite, q: string, params: unknown[] = []) => Object.values((await db.query<Record<string, unknown>>(q, params)).rows[0])[0];

describe('times from Donary and Sola', () => {
  let base: PGlite;
  let db: PGlite;
  beforeAll(async () => { base = await seededDb(); });
  beforeEach(async () => { db = await base.clone(); });
  const at = (q: string, params: unknown[] = []) => val(db, `select to_char((${q}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`, params);

  it('reads a time with no zone in the organization\'s zone (New York), in winter and in summer', async () => {
    expect(await at(`public.donary_time('2026-11-15T12:54:02', $1)`, [OIZER])).toBe('2026-11-15T17:54:02Z');
    expect(await at(`public.donary_time('2026-07-01T09:00:00', $1)`, [OIZER])).toBe('2026-07-01T13:00:00Z');
    expect(await at(`public.local_time_text('2026-11-15T12:54:02', $1)::timestamptz`, [OIZER])).toBe('2026-11-15T17:54:02Z');
  });

  it('takes a time that carries its zone as it is, and follows the organization\'s own time zone setting', async () => {
    expect(await at(`public.donary_time('2026-11-15T12:54:02Z', $1)`, [OIZER])).toBe('2026-11-15T12:54:02Z');
    expect(await at(`public.local_time_text('2026-11-15T12:54:02-08:00', $1)::timestamptz`, [OIZER])).toBe('2026-11-15T20:54:02Z');
    await db.query(`insert into public.settings (org_id, key, value) values ($1, 'timezone', '"America/Los_Angeles"') on conflict (org_id, key) do update set value = excluded.value`, [OIZER]);
    expect(await at(`public.donary_time('2026-11-15T12:54:02', $1)`, [OIZER])).toBe('2026-11-15T20:54:02Z');
    expect(await val(db, `select public.local_time_text('', $1)`, [OIZER])).toBeNull();
  });
});
