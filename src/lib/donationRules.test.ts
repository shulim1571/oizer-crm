import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { allowedStatuses, DONATION_TRANSITIONS } from './donationRules';
import { DONATION_STATUSES } from './lookups';

describe('donation edit rules', () => {
  it('match the database list of allowed status steps', () => {
    const sql = readFileSync('supabase/migrations/20261209000000_donation_edit_rules.sql', 'utf8');
    const list = sql.slice(sql.indexOf('function public.donation_status_allowed'), sql.indexOf('function public.donation_edit_guard'));
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
