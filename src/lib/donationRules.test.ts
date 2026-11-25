import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { allowedStatuses, DONATION_TRANSITIONS } from './donationRules';
import { DONATION_STATUSES } from './lookups';

describe('donation edit rules', () => {
  it('match the database list of allowed status steps', () => {
    // The latest migration that defines the list (it was extended for held Donary cash and checks, 2026-11-25).
    const file = readdirSync('supabase/migrations').filter(f => f.endsWith('.sql')).sort().reverse()
      .find(f => readFileSync(`supabase/migrations/${f}`, 'utf8').includes('function public.donation_status_allowed'))!;
    const sql = readFileSync(`supabase/migrations/${file}`, 'utf8');
    const start = sql.indexOf('function public.donation_status_allowed');
    const list = sql.slice(start, sql.indexOf('$$;', sql.indexOf('$$', start) + 2));
    const db = [...list.matchAll(/\('(\w+)', '(\w+)'\)/g)].map(m => `${m[1]}>${m[2]}`).sort();
    const app = Object.entries(DONATION_TRANSITIONS).flatMap(([from, to]) => to.map(t => `${from}>${t}`)).sort();
    expect(app).toEqual(db);
  });

  it('cover every status, and never offer failed to completed', () => {
    expect(Object.keys(DONATION_TRANSITIONS).sort()).toEqual(DONATION_STATUSES.map(s => s.value).sort());
    expect(allowedStatuses('failed')).toEqual(['failed']);
    expect(allowedStatuses('completed')).toContain('refunded');
  });
});
